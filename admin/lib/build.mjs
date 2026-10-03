// 构建编排：先运行 `astro build`，再原子化地发布构建产物，确保线上站点永远
// 不会返回构建到一半的页面。
//
// 这里产生的目录结构：
//   dist/               Astro 构建产物（每次构建都是全新的）
//   releases/<ts>/      已发布的快照
//   current  -> releases/<ts>   nginx 对外提供服务的目录
//
// 成功时，dist/ 会被重命名为 releases/<ts>，`current` 链接在一步原子操作中
// 完成切换。失败时，正在运行的站点（current）保持原样不受影响。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ROOT } from './env.mjs';
import { logWarn } from './log.mjs';

const RELEASES_DIR = path.join(ROOT, 'releases');
const CURRENT = path.join(ROOT, 'current');
const DIST = path.join(ROOT, 'dist');
const LOCK_DIR = path.join(ROOT, '.build-lock');
const STATUS_FILE = path.join(RELEASES_DIR, '.last-build.json');
const KEEP_RELEASES = 5;
const LOG_LIMIT = 200_000; // 最多保留约 200KB 的构建输出

const rmrf = (p) => {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {
    /* 忽略 */
  }
};

// 删除源文件时，Astro 的 content-layer 缓存不会被清理，因此重新构建可能仍会
// 输出已删除的文章。解决办法是清空缓存，让构建重新扫描 src/content/ —— 但
// 清空缓存也会破坏并发运行的 `npm run dev` 的状态，因为两者共用同一批文件。
// 新增和修改无需清缓存即可被识别，所以只有确实发生删除时才清空缓存。是否
// 发生删除，是通过我们自己维护的清单（记录上次构建所见的内容文件）来检测
// 的 —— 刻意不去解析 Astro 内部的 data-store，其格式属于实现细节。
function clearContentCache() {
  rmrf(path.join(ROOT, '.astro'));
  rmrf(path.join(ROOT, 'node_modules', '.astro'));
  rmrf(path.join(ROOT, 'node_modules', '.vite'));
}

const CONTENT_MANIFEST = path.join(ROOT, '.content-build-manifest.json');

function listContentFiles() {
  const out = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        out.push(path.relative(ROOT, full).replace(/\\/g, '/'));
      }
    }
  };
  walk(path.join(ROOT, 'src', 'content', 'posts'));
  walk(path.join(ROOT, 'src', 'content', 'notes'));
  return out.sort();
}

// 如果上次构建所见的内容文件此后被删除，则返回 true。
export function contentWasDeletedSinceLastBuild(manifestPath = CONTENT_MANIFEST) {
  if (!fs.existsSync(manifestPath)) return false;
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    return false;
  }
  if (!Array.isArray(manifest)) return false;
  return manifest.some((rel) => {
    if (typeof rel !== 'string') return false;
    return !fs.existsSync(path.join(ROOT, rel));
  });
}

function writeContentManifest() {
  try {
    const tmp = CONTENT_MANIFEST + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(listContentFiles(), null, 2), 'utf8');
    fs.renameSync(tmp, CONTENT_MANIFEST);
  } catch (err) {
    logWarn('内容构建清单写入失败', err);
  }
}

function acquireLock() {
  try {
    fs.mkdirSync(LOCK_DIR);
    try {
      fs.writeFileSync(path.join(LOCK_DIR, 'pid'), String(process.pid));
    } catch {
      /* 忽略 */
    }
    return true;
  } catch (e) {
    if (e.code === 'EEXIST') {
      let age = 0;
      try {
        age = Date.now() - fs.statSync(LOCK_DIR).mtimeMs;
      } catch {
        /* 忽略 */
      }
      // 已崩溃的构建不应永远阻塞发布。
      if (age > 15 * 60 * 1000) {
        rmrf(LOCK_DIR);
        return acquireLock();
      }
      throw new Error('已有构建正在进行中，请稍候再试。');
    }
    throw e;
  }
}

function releaseLock() {
  rmrf(LOCK_DIR);
}

// 剥离 ANSI 转义序列（颜色 / 光标 / 窗口标题等控制符）：astro、npm 往管道输出
// 时会带上这些序列，原样存进日志后在后台 <pre> 里就显示成乱码。覆盖 CSI、
// OSC、字符集指定（如 ESC ( B）与单字符转义几种形式。
// eslint-disable-next-line no-control-regex -- 剥离 ANSI 控制序列必然匹配控制字符
const ANSI_RE = /\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[()][0-9A-Za-z@-~]|[@-Z\\-_])/g;

export function stripAnsi(text) {
  return String(text ?? '').replace(ANSI_RE, '');
}

export function runCommand(command, args) {
  return new Promise((resolve) => {
    // shell：npm 在 Windows 上是 .cmd 文件，Node 的 spawn 不借助 shell 无法
    // 运行 .cmd（报 EINVAL）。这里的命令是固定字符串（不含用户输入），因此
    // 使用 shell 不会引入注入风险，在 Linux 上也能正常工作。
    // 中文 Windows 的 cmd.exe 自身消息按 OEM 代码页（GBK）编码，先用 chcp
    // 切到 UTF-8，避免 cmd 的报错以 GBK 字节混进日志（其余输出本来就是 UTF-8）。
    const isWin = process.platform === 'win32';
    // FORCE_COLOR / NO_COLOR 让构建工具尽量别输出颜色，转义序列再由 stripAnsi 兜底。
    const env = { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' };
    const child = isWin
      ? spawn('cmd.exe', ['/d', '/s', '/c', `chcp 65001>nul&& ${command} ${args.join(' ')}`], {
          cwd: ROOT,
          env,
          windowsHide: true,
        })
      : spawn(command, args, { cwd: ROOT, env, shell: true, windowsHide: true });

    // 收集原始字节，结束时整体解码：转义序列可能跨 chunk 边界，逐块 toString
    // 会留下半截转义码。构建输出仅几百 KB，无需流式处理。
    const chunks = [];
    let size = 0;
    const append = (chunk) => {
      chunks.push(chunk);
      size += chunk.length;
      while (size > LOG_LIMIT * 2 && chunks.length > 1) {
        size -= chunks[0].length;
        chunks.shift();
      }
    };
    const decode = () =>
      stripAnsi(Buffer.concat(chunks).toString('utf8')).slice(-LOG_LIMIT);

    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.on('error', (err) => resolve({ code: -1, output: decode() + `\n${err.message}` }));
    child.on('close', (code) => resolve({ code, output: decode() }));
  });
}

function publish(releaseDir) {
  const type = process.platform === 'win32' ? 'junction' : 'dir';
  const target = process.platform === 'win32' ? releaseDir : path.relative(ROOT, releaseDir);
  const tmpLink = path.join(ROOT, '.current-tmp');
  rmrf(tmpLink);
  fs.symlinkSync(target, tmpLink, type);
  if (process.platform === 'win32') {
    // Windows 的 rename 无法替换已存在的目录链接：把旧链接先改名挪开
    // （而非删除），再把新链接改名到位——两次 rename 之间的窗口只有
    // 「链接缺失」而不是「已删除且未就位」，且旧链接改名失败可立即恢复。
    const backupLink = path.join(ROOT, '.current-old');
    rmrf(backupLink);
    let moved = false;
    try {
      if (fs.existsSync(CURRENT)) {
        fs.renameSync(CURRENT, backupLink);
        moved = true;
      }
      fs.renameSync(tmpLink, CURRENT);
      rmrf(backupLink);
    } catch (err) {
      // 切换失败时把旧链接挪回来，保证线上目录始终存在。
      if (moved) {
        try {
          fs.renameSync(backupLink, CURRENT);
        } catch {
          /* 恢复也失败时只能报错，交由运维处理 */
        }
      }
      throw err;
    }
    return;
  }
  fs.renameSync(tmpLink, CURRENT);
}

function listReleases() {
  if (!fs.existsSync(RELEASES_DIR)) return [];
  return fs
    .readdirSync(RELEASES_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

function pruneReleases() {
  const releases = listReleases();
  const currentName = currentRelease();
  const excess = releases.slice(0, Math.max(0, releases.length - KEEP_RELEASES));
  for (const name of excess) {
    if (name === currentName) continue;
    rmrf(path.join(RELEASES_DIR, name));
  }
}

export function currentRelease() {
  try {
    return path.basename(fs.realpathSync(CURRENT));
  } catch {
    return null;
  }
}

function writeStatus(status) {
  try {
    fs.mkdirSync(RELEASES_DIR, { recursive: true });
    // 与 store.mjs 一致走临时文件 + 原子重命名，避免崩溃时留下半截 JSON。
    const tmp = `${STATUS_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(status, null, 2), 'utf8');
    fs.renameSync(tmp, STATUS_FILE);
  } catch (err) {
    logWarn('构建状态写入失败', err);
  }
}

export function lastBuildStatus() {
  try {
    return JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8'));
  } catch {
    return null;
  }
}

export function isBuilding() {
  return fs.existsSync(LOCK_DIR);
}

// 构建并发布站点。Promise 以 { ok, log, release, message } 兑现。
export async function buildAndPublish() {
  if (!acquireLock()) throw new Error('已有构建正在进行中。');
  const startedAt = new Date().toISOString();
  writeStatus({ status: 'building', startedAt });
  try {
    let cacheRebuilt = false;
    if (contentWasDeletedSinceLastBuild()) {
      clearContentCache();
      cacheRebuilt = true;
    }
    const { code, output } = await runCommand('npm', ['run', 'build']);

    if (code !== 0) {
      const status = {
        status: 'failed',
        startedAt,
        finishedAt: new Date().toISOString(),
        exitCode: code,
        log: output,
      };
      writeStatus(status);
      return { ok: false, log: output, release: currentRelease(), message: '构建失败，线上站点保持原样。' };
    }

    if (!fs.existsSync(DIST)) {
      const status = { status: 'failed', startedAt, finishedAt: new Date().toISOString(), log: output + '\n未找到构建产物 dist/。' };
      writeStatus(status);
      return { ok: false, log: output, release: currentRelease(), message: '构建未产出 dist/ 目录。' };
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const releaseDir = path.join(RELEASES_DIR, stamp);
    fs.mkdirSync(RELEASES_DIR, { recursive: true });
    fs.renameSync(DIST, releaseDir);
    publish(releaseDir);
    pruneReleases();

    const status = {
      status: 'success',
      startedAt,
      finishedAt: new Date().toISOString(),
      release: stamp,
      log: output,
    };
    writeStatus(status);
    writeContentManifest();
    const cacheNote = cacheRebuilt
      ? '（检测到已删除的内容，已重建构建缓存；若本地 npm run dev 预览异常请重启它）'
      : '';

    // 发布成功后自动把个人数据备份到私人仓库（全程使用系统临时目录，本地
    // 不留备份缓存）。备份失败绝不影响本次发布的成败，只在日志里说明原因；
    // 推送失败则该次备份作废，下次发布会自动重试。
    // 延迟导入：避免与 backup.mjs 形成顶层循环依赖。
    let backup = null;
    try {
      const { runBackup } = await import('./backup.mjs');
      backup = await runBackup(stamp);
    } catch (err) {
      backup = { ok: false, pushed: false, summary: `备份流程异常：${err?.message || err}` };
    }
    status.backup = { ok: backup.ok, pushed: !!backup.pushed, summary: backup.summary };
    status.log = `${output}\n\n—— 数据备份 ——\n${backup.summary}`;
    writeStatus(status);

    return {
      ok: true,
      log: status.log,
      release: stamp,
      cacheRebuilt,
      backup,
      message: `构建成功并已发布。${cacheNote}数据备份：${backup.ok ? backup.summary : '失败（详见日志）。'}`,
    };
  } finally {
    releaseLock();
  }
}

// 把 `current` 重新指向上一个版本。返回回滚到的版本。
export function rollback() {
  const releases = listReleases();
  const currentName = currentRelease();
  const idx = releases.indexOf(currentName);
  if (idx <= 0) throw new Error('没有更早的版本可回滚。');
  const target = releases[idx - 1];
  publish(path.join(RELEASES_DIR, target));
  return target;
}

export function releasesInfo() {
  const currentName = currentRelease();
  return listReleases()
    .map((name) => ({ name, current: name === currentName }))
    .reverse();
}
