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
  } catch {
    /* 忽略 */
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

function runCommand(command, args) {
  return new Promise((resolve) => {
    // shell：npm 在 Windows 上是 .cmd 文件，Node 的 spawn 不借助 shell 无法
    // 运行 .cmd（报 EINVAL）。这里的命令是固定字符串（不含用户输入），因此
    // 使用 shell 不会引入注入风险，在 Linux 上也能正常工作。
    const child = spawn(command, args, {
      cwd: ROOT,
      env: process.env,
      shell: true,
      windowsHide: true,
    });
    let output = '';
    const append = (chunk) => {
      output += chunk.toString();
      if (output.length > LOG_LIMIT) {
        output = output.slice(output.length - LOG_LIMIT);
      }
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.on('error', (err) => resolve({ code: -1, output: output + `\n${err.message}` }));
    child.on('close', (code) => resolve({ code, output }));
  });
}

function publish(releaseDir) {
  const type = process.platform === 'win32' ? 'junction' : 'dir';
  const target = process.platform === 'win32' ? releaseDir : path.relative(ROOT, releaseDir);
  const tmpLink = path.join(ROOT, '.current-tmp');
  rmrf(tmpLink);
  fs.symlinkSync(target, tmpLink, type);
  if (process.platform === 'win32') {
    // Windows 的 rename 无法替换已存在的目录链接；需先删除（仅开发环境）。
    rmrf(CURRENT);
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
    fs.writeFileSync(STATUS_FILE, JSON.stringify(status, null, 2), 'utf8');
  } catch {
    /* 忽略 */
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
    return { ok: true, log: output, release: stamp, cacheRebuilt, message: `构建成功并已发布。${cacheNote}` };
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
