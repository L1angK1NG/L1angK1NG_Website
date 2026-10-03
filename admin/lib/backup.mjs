// 自动数据备份：每次「构建发布」成功后，把公开仓库之外的个人数据直接推送到
// GitHub 私有仓库作为异地备份。整个过程在系统临时目录里完成：建临时仓库 →
// 拉取远端历史衔接 → 镜像复制数据 → 提交 → 推送 → 删除临时仓库，本地零残留。
//
// 备份范围（全部是 .gitignore 排除、无法从公开仓库重建的内容）：
//   src/content/      文章与随笔（Markdown）
//   public/uploads/   后台上传的媒体
//   data/             动态数据（评论/友链/歌单/公告/统计/项目/导航/页面文案）
//   profile.jpg       个人头像
//   .env              站点配置与后台凭据（可经 BACKUP_INCLUDE_ENV=false 关闭）
//
// 构建产物 dist/、releases/ 不备份：源码 + 以上数据即可随时完整重建。
//
// 远端历史保持连续：临时仓库每次先拉取远端最新提交再叠加快照提交，文章/媒体
// 的历史版本在私库中完整可回溯。备份失败只记录原因，绝不影响发布结果；某次
// 推送失败时该次备份作废（数据源在项目内不会丢失），下次发布会自动全量重试。
// 未配置远端地址时无处可推，直接跳过备份，也不在本地产生任何缓存。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { ROOT } from './env.mjs';
import { readJSON, writeJSON } from './store.mjs';

const BACKUP_ENABLED = (process.env.BACKUP_ENABLED ?? 'true') !== 'false';
// 临时备份仓库：系统临时目录下的固定名目录，推送完成后整个删除，本地零残留。
const BACKUP_TMP_DIR = path.join(os.tmpdir(), `${path.basename(ROOT)}-backup-tmp`);

// 后台在构建发布页保存的仓库地址（data/backup-config.json）。
// 远端地址的生效优先级：后台配置 > 环境变量 BACKUP_REMOTE_URL > 自动推导。
const BACKUP_CONFIG_FILE = 'backup-config.json';

function uiRemoteUrl() {
  const cfg = readJSON(BACKUP_CONFIG_FILE, {});
  return typeof cfg.remoteUrl === 'string' ? cfg.remoteUrl.trim() : '';
}

// 未在后台/环境变量配置远端时，从主仓库 origin 推导默认私库地址：
// github.com/<owner>/<repo> → github.com/<owner>/<repo>-backup（私有仓库）。
// 解析不出（非 GitHub 远端/无 origin）则返回空串，此时跳过备份。
function defaultRemoteUrl() {
  try {
    const r = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
    if (r.status !== 0) return '';
    const m = String(r.stdout).trim().match(/github\.com[/:](.+?)\/(.+?)(?:\.git)?\/?$/i);
    return m ? `https://github.com/${m[1]}/${m[2]}-backup.git` : '';
  } catch {
    return '';
  }
}

// 当前实际生效的远端地址；空串表示未配置，备份跳过。
export function effectiveRemoteUrl() {
  return uiRemoteUrl() || (process.env.BACKUP_REMOTE_URL || '').trim() || defaultRemoteUrl();
}

// 校验用户在后台填写的仓库地址：只接受标准 Git 远端格式（顺带保证它永远不会
// 以 "-" 开头被 git 当作选项解析），地址作为单个参数传给 git，无 shell 注入面。
export function validateRemoteUrl(input) {
  const s = String(input ?? '').trim();
  if (!s) return { ok: true, empty: true };
  if (s.length > 500) return { ok: false, error: '仓库地址过长（最多 500 字符）。' };
  if (/\s/.test(s)) return { ok: false, error: '仓库地址不能包含空白字符。' };
  if (!/^(https?:\/\/|ssh:\/\/|git@)\S+$/i.test(s)) {
    return { ok: false, error: '地址格式不正确：支持 https://、http://、ssh:// 或 git@ 开头的 Git 仓库地址。' };
  }
  return { ok: true, value: s };
}

// 读取备份配置（构建页展示用）：后台保存值 + 实际生效值 + 生效来源说明。
export function getBackupConfig() {
  const ui = uiRemoteUrl();
  const effective = effectiveRemoteUrl();
  const source = ui ? 'ui' : (process.env.BACKUP_REMOTE_URL || '').trim() ? 'env' : effective ? 'auto' : 'none';
  const sourceLabel = { ui: '后台配置', env: '环境变量 BACKUP_REMOTE_URL', auto: '自动推导（主仓库地址 + -backup）', none: '未配置' }[source];
  return { remoteUrl: ui, effective, source, sourceLabel };
}

// 保存后台填写的仓库地址；留空 = 撤销后台配置、回落到默认来源。
export function saveBackupRemoteUrl(input) {
  const v = validateRemoteUrl(input);
  if (!v.ok) return { ok: false, error: v.error };
  const remoteUrl = v.empty ? '' : v.value;
  writeJSON(BACKUP_CONFIG_FILE, { remoteUrl, savedAt: new Date().toISOString() });
  const effective = effectiveRemoteUrl();
  return {
    ok: true,
    remoteUrl,
    effective,
    message: effective
      ? `仓库地址已保存，下次发布备份将推送到 ${effective}`
      : '已保存。当前未配置远端仓库地址，下次发布将跳过备份。',
  };
}
// .env 含密码哈希与会话密钥，私库务必私有；默认备份以保证可完整恢复
const INCLUDE_ENV = (process.env.BACKUP_INCLUDE_ENV ?? 'true') !== 'false';
// fetch/push 等待上限：网络差时别让「构建发布」按钮无限等待
const NET_TIMEOUT_MS = 90_000;

// 串行化：后台发布与命令行 deploy 可能并发调用，备份动作排队执行。
let queue = Promise.resolve();

// 复用构建日志的 ANSI 剥离逻辑（git 输出同样可能带控制序列）。
// 延迟导入以避免与 build.mjs 形成顶层循环依赖。
async function ansiStripper() {
  return (await import('./build.mjs')).stripAnsi;
}

function spawnGit(args, cwd) {
  return new Promise((resolve) => {
    // 不经 shell：commit message 含中文与括号，Windows 的 cmd 会按 GBK
    // 处理导致乱码；直接 CreateProcess 传参则全程 UTF-16 无此问题。
    const child = spawn('git', args, { cwd, windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = args[0] === 'push' || args[0] === 'fetch' ? setTimeout(() => child.kill(), NET_TIMEOUT_MS) : null;
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr + err.message });
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

// 统计目录下的文件数与总字节数，用于备份摘要。
function dirStats(dir) {
  let files = 0;
  let bytes = 0;
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        files += 1;
        bytes += fs.statSync(full).size;
      }
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return { files, bytes };
}

const fmtSize = (bytes) =>
  bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`;

// 初始化临时备份仓库：提交身份沿用主仓库的配置，避免依赖全局 git config；
// origin 指向本次生效的远端地址（后台改地址或 .env 改地址即时生效）。
async function setupTempRepo(git, remoteUrl) {
  let r = await git(['init', '-b', 'main']);
  if (r.code !== 0) {
    // 老版本 git 不支持 -b：初始化后把 unborn 分支改名为 main
    await git(['init']);
    await git(['symbolic-ref', 'HEAD', 'refs/heads/main']);
  }
  const name = (await git(['config', 'user.name'])).stdout.trim() || 'L1angK1NG';
  const email =
    (await git(['config', 'user.email'])).stdout.trim() || 'L1angK1NG@users.noreply.github.com';
  await git(['config', 'user.name', name]);
  await git(['config', 'user.email', email]);
  await git(['remote', 'add', 'origin', remoteUrl]);
  writeReadme();
}

const README_TEXT = `# L1angK1NG_Website 数据备份

由博客后台在每次「构建发布」成功后自动推送，远端为 GitHub 私有仓库。

## 备份范围（公开仓库之外、无法重建的个人数据）

- \`src/content/\`    文章与随笔（Markdown）
- \`public/uploads/\` 后台上传的媒体
- \`data/\`           动态数据（评论/友链/歌单/公告/统计/项目/导航/页面文案）
- \`profile.jpg\`     个人头像
- \`.env\`            站点配置与后台凭据（含密码哈希与会话密钥——**本仓库务必保持私有**）

构建产物不在备份范围：源码 + 以上数据即可随时完整重建。

## 恢复步骤

1. 克隆公开源码仓库，\`npm install\`
2. 克隆本仓库，把 \`src/content\`、\`public/uploads\`、\`data\`、\`profile.jpg\`、\`.env\`
   拷贝到项目对应位置
3. \`npm run deploy\` 重新构建发布
`;

function writeReadme() {
  try {
    fs.writeFileSync(path.join(BACKUP_TMP_DIR, 'BACKUP-README.md'), README_TEXT, 'utf8');
  } catch {
    /* 忽略 */
  }
}

// 远端推送失败的常见原因归类，给出可执行的下一步提示。
function classifyPushError(stderr) {
  const s = stderr.toLowerCase();
  if (/repository not found|does not appear to be a git repository|404|not found/.test(s)) {
    return '远端仓库不存在或无权访问。请先在 GitHub 上创建一个私有空仓库（名称与远端地址一致），完成后无需任何操作，下次「构建发布」或 npm run backup 会自动重试。';
  }
  if (/authentication failed|could not read username|could not read password|permission denied|403/.test(s)) {
    return '远端认证失败：请在本机完成一次 GitHub 登录（Git 凭据管理器会弹出授权窗口），然后运行 npm run backup 重试。';
  }
  if (/\[rejected\]|non-fast-forward|fetch first/.test(s)) {
    return '远端已有备份历史，但本次临时仓库未能衔接（多为网络波动导致拉取历史失败）。下次「构建发布」会自动重试。';
  }
  if (/timed?\s?out|could not resolve host|failed to connect|unable to access|connection/.test(s)) {
    return '网络异常，暂时无法连接远端。下次发布成功后会自动重试。';
  }
  return '远端推送失败。下次发布成功后会自动重试。';
}

// 镜像复制的数据清单：源路径（相对项目根）→ 备份路径（相对备份仓库根）。
// 目录不存在时自动跳过（例如尚未上传过任何媒体）。
const BACKUP_ITEMS = [
  ['src/content', path.join('src', 'content')],
  ['public/uploads', path.join('public', 'uploads')],
  ['data', 'data'],
  ['profile.jpg', 'profile.jpg'],
];
if (INCLUDE_ENV) BACKUP_ITEMS.push(['.env', '.env']);

// 执行一次备份。release 为本次对应的发布版本号（手动备份时可为 null）。
// 本函数永不抛异常：任何失败都折叠进返回值 { ok, summary, ... }。
export function runBackup(release = null) {
  const run = async () => {
    const base = { ok: false, committed: false, pushed: false, dir: BACKUP_TMP_DIR };
    if (!BACKUP_ENABLED) {
      return { ...base, ok: true, skipped: true, summary: '备份未启用（BACKUP_ENABLED=false），已跳过。' };
    }
    const remoteUrl = effectiveRemoteUrl();
    if (!remoteUrl) {
      return {
        ...base,
        skipped: true,
        summary: '未配置备份远端仓库地址（可在构建发布页或 BACKUP_REMOTE_URL 配置），本次备份已跳过。',
      };
    }
    const stripAnsi = await ansiStripper();
    const git = async (args) => {
      const r = await spawnGit(args, BACKUP_TMP_DIR);
      return { ...r, stdout: stripAnsi(r.stdout), stderr: stripAnsi(r.stderr) };
    };

    try {
      // 上次备份若因进程中断残留了临时目录，先清掉再重新建仓
      fs.rmSync(BACKUP_TMP_DIR, { recursive: true, force: true });
      fs.mkdirSync(BACKUP_TMP_DIR, { recursive: true });

      try {
        await setupTempRepo(git, remoteUrl);
      } catch (err) {
        return { ...base, error: String(err.message || err), summary: `临时备份仓库初始化失败（${BACKUP_TMP_DIR}）：${err.message || err}` };
      }

      // 衔接远端历史：拉取远端最新提交并把 HEAD 软重置过去，本次提交即叠加
      // 在历史之上（文章/媒体的历史版本在私库中可回溯）。失败（首次推送/
      // 空仓库/网络异常）则忽略，从头建历史；远端非空且未衔接时 push 会被
      // 拒绝，走推送失败提示，不会覆盖远端。
      const fetch = await git(['fetch', 'origin', 'main']);
      if (fetch.code === 0) await git(['reset', '--soft', 'FETCH_HEAD']);

      // 镜像复制各数据目录/文件
      const items = [];
      for (const [srcRel, destRel] of BACKUP_ITEMS) {
        const src = path.join(ROOT, srcRel);
        const dest = path.join(BACKUP_TMP_DIR, destRel);
        if (!fs.existsSync(src)) continue;
        fs.cpSync(src, dest, { recursive: true });
        const st = fs.statSync(src);
        const { files, bytes } = st.isDirectory() ? dirStats(src) : { files: 1, bytes: st.size };
        items.push({ path: srcRel.replace(/\\/g, '/'), files, bytes });
      }

      // 记录本次备份的元信息（随仓库一起提交，便于日后追溯版本对应关系）
      const total = items.reduce((acc, i) => ({ files: acc.files + i.files, bytes: acc.bytes + i.bytes }), { files: 0, bytes: 0 });
      const meta = {
        backedUpAt: new Date().toISOString(),
        release,
        items,
        totalFiles: total.files,
        totalBytes: total.bytes,
      };
      fs.writeFileSync(path.join(BACKUP_TMP_DIR, 'backup-meta.json'), JSON.stringify(meta, null, 2), 'utf8');

      // 提交：快照与远端最新一致时（数据无变化）跳过 commit，但仍会确认 push
      await git(['add', '-A']);
      const dirty = (await git(['status', '--porcelain'])).stdout.trim().length > 0;
      if (dirty) {
        const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
        const subject = release ? `数据备份：发布版本 ${release}` : `数据备份（${stamp}）`;
        const body = items.map((i) => `- ${i.path}: ${i.files} 个文件，${fmtSize(i.bytes)}`).join('\n');
        const r = await git(['commit', '-m', `${subject}\n\n${body}`]);
        if (r.code !== 0) {
          return { ...base, error: r.stderr, summary: `备份提交失败：${(r.stderr || r.stdout).trim().slice(-300)}` };
        }
      }

      const result = {
        ...base,
        ok: true,
        committed: dirty,
        totalFiles: total.files,
        totalBytes: total.bytes,
      };

      // push：失败不影响发布结果，该次备份作废（临时目录随 finally 删除），
      // 下次发布会基于项目内数据自动全量重试
      const push = await git(['push', 'origin', 'main']);
      if (push.code === 0) {
        return {
          ...result,
          pushed: true,
          summary: `数据已备份并推送到私人仓库${dirty ? '' : '（数据无变化）'}：${remoteUrl}；本地未保留缓存。`,
        };
      }
      return {
        ...result,
        pushed: false,
        error: (push.stderr || push.stdout).trim().slice(-500),
        summary: `备份推送到 ${remoteUrl} 未完成：${classifyPushError(push.stderr || push.stdout)}`,
      };
    } catch (err) {
      return { ...base, error: String(err.message || err), summary: `备份过程出错：${err.message || err}` };
    } finally {
      // 无论成败都删掉临时仓库：成功则本地无需保留；失败则该次作废，数据源
      // 在项目内不会丢失，下次自动全量重试。
      try {
        fs.rmSync(BACKUP_TMP_DIR, { recursive: true, force: true });
      } catch {
        /* 忽略 */
      }
    }
  };
  return (queue = queue.then(run, run));
}
