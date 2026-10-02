// 自动数据备份：每次「构建发布」成功后，把公开仓库之外的个人数据镜像到
// 一个独立的本地 git 仓库，并推送到 GitHub 私有仓库作为异地备份。
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
// 备份仓库默认位于项目同级目录（必须在项目外：避免嵌套 git 仓库，也避免
// 提交钩子把备份数据误当项目改动扫描）。备份失败只记录原因，绝不影响
// 发布结果；推送失败时本地提交已保留，下次发布会自动补推。
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { ROOT } from './env.mjs';
import { readJSON, writeJSON } from './store.mjs';

const BACKUP_ENABLED = (process.env.BACKUP_ENABLED ?? 'true') !== 'false';
// 留空/未配置时用项目同级目录，如 E:\Project\Web_Project\L1angK1NG_Website-backup
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(ROOT, '..', `${path.basename(ROOT)}-backup`);

// 后台在构建发布页保存的仓库地址（data/backup-config.json）。
// 远端地址的生效优先级：后台配置 > 环境变量 BACKUP_REMOTE_URL > 自动推导。
const BACKUP_CONFIG_FILE = 'backup-config.json';

function uiRemoteUrl() {
  const cfg = readJSON(BACKUP_CONFIG_FILE, {});
  return typeof cfg.remoteUrl === 'string' ? cfg.remoteUrl.trim() : '';
}

// 未在后台/环境变量配置远端时，从主仓库 origin 推导默认私库地址：
// github.com/<owner>/<repo> → github.com/<owner>/<repo>-backup（私有仓库）。
// 解析不出（非 GitHub 远端/无 origin）则返回空串，此时只做本地备份。
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

// 当前实际生效的远端地址；空串表示只做本地备份、不推送
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
      : '已保存。当前未配置远端仓库地址，备份仅保留在本地。',
  };
}
// .env 含密码哈希与会话密钥，私库务必私有；默认备份以保证可完整恢复
const INCLUDE_ENV = (process.env.BACKUP_INCLUDE_ENV ?? 'true') !== 'false';
// push 等待上限：网络差时别让「构建发布」按钮无限等待
const PUSH_TIMEOUT_MS = 90_000;

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
    const timer = args[0] === 'push' ? setTimeout(() => child.kill(), PUSH_TIMEOUT_MS) : null;
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

// 首次使用时初始化备份仓库；之后每次按当前生效地址校正 origin（后台改地址
// 或 .env 改地址都会在下一次备份时自动同步过去）。
async function ensureRepo(git) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const gitDir = path.join(BACKUP_DIR, '.git');
  const remoteUrl = effectiveRemoteUrl();
  if (!fs.existsSync(gitDir)) {
    let r = await git(['init', '-b', 'main']);
    if (r.code !== 0) {
      // 老版本 git 不支持 -b：初始化后把 unborn 分支改名为 main
      await git(['init']);
      await git(['symbolic-ref', 'HEAD', 'refs/heads/main']);
    }
    // 提交身份沿用主仓库的配置，避免依赖全局 git config
    const name = (await git(['config', 'user.name'])).stdout.trim() || 'L1angK1NG';
    const email =
      (await git(['config', 'user.email'])).stdout.trim() || 'L1angK1NG@users.noreply.github.com';
    await git(['config', 'user.name', name]);
    await git(['config', 'user.email', email]);
    if (remoteUrl) await git(['remote', 'add', 'origin', remoteUrl]);
  } else if (remoteUrl) {
    // 补加/同步 origin：首次建仓时若未配置远端，之后改配置要能生效
    const current = (await git(['remote', 'get-url', 'origin'])).stdout.trim();
    if (!current) await git(['remote', 'add', 'origin', remoteUrl]);
    else if (current !== remoteUrl) await git(['remote', 'set-url', 'origin', remoteUrl]);
  }
  writeReadme();
}

const README_TEXT = `# L1angK1NG_Website 数据备份

由博客后台在每次「构建发布」成功后自动生成并推送，远端为 GitHub 私有仓库。

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
    fs.writeFileSync(path.join(BACKUP_DIR, 'BACKUP-README.md'), README_TEXT, 'utf8');
  } catch {
    /* 忽略 */
  }
}

// 把备份工作区还原成「纯镜像」：清掉上次的内容再复制，保证已删除的
// 文章/媒体在备份里也同步消失（cp 合并式复制做不到这一点）。
function resetWorktree() {
  for (const entry of fs.readdirSync(BACKUP_DIR, { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    fs.rmSync(path.join(BACKUP_DIR, entry.name), { recursive: true, force: true });
  }
}

// 远端推送失败的常见原因归类，给出可执行的下一步提示。
function classifyPushError(stderr) {
  const s = stderr.toLowerCase();
  if (/repository not found|does not appear to be a git repository|404|not found/.test(s)) {
    return '远端仓库不存在或无权访问。请先在 GitHub 上创建一个私有空仓库（名称与远端地址一致），完成后无需任何操作，下次「构建发布」或 npm run backup 会自动补推。';
  }
  if (/authentication failed|could not read username|could not read password|permission denied|403/.test(s)) {
    return '远端认证失败：请在本机完成一次 GitHub 登录（Git 凭据管理器会弹出授权窗口），然后运行 npm run backup 重试。';
  }
  if (/timed?\s?out|could not resolve host|failed to connect|unable to access|connection/.test(s)) {
    return '网络异常，暂时无法连接远端。本地提交已保存，下次发布成功后会自动补推。';
  }
  return '远端推送失败。本地提交已保存，下次发布成功后会自动补推。';
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
    const base = { ok: false, committed: false, pushed: false, dir: BACKUP_DIR };
    if (!BACKUP_ENABLED) {
      return { ...base, ok: true, skipped: true, summary: '备份未启用（BACKUP_ENABLED=false），已跳过。' };
    }
    const stripAnsi = await ansiStripper();
    const git = async (args) => {
      const r = await spawnGit(args, BACKUP_DIR);
      return { ...r, stdout: stripAnsi(r.stdout), stderr: stripAnsi(r.stderr) };
    };

    try {
      await ensureRepo(git);
    } catch (err) {
      return { ...base, error: String(err.message || err), summary: `备份仓库初始化失败（${BACKUP_DIR}）：${err.message || err}` };
    }

    try {
      // 镜像复制各数据目录/文件
      resetWorktree();
      const items = [];
      for (const [srcRel, destRel] of BACKUP_ITEMS) {
        const src = path.join(ROOT, srcRel);
        const dest = path.join(BACKUP_DIR, destRel);
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
      fs.writeFileSync(path.join(BACKUP_DIR, 'backup-meta.json'), JSON.stringify(meta, null, 2), 'utf8');

      // 提交：工作区与上次一致时（数据无变化）跳过 commit，但仍会尝试 push
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

      const remoteUrl = effectiveRemoteUrl();
      if (!remoteUrl) {
        return {
          ...result,
          summary: `数据已备份到本地仓库 ${BACKUP_DIR}${dirty ? '（已提交）' : '（数据无变化）'}；未配置远端仓库地址，暂不推送。`,
        };
      }

      // push：失败不影响发布结果；本地提交已保留，下次自动补推
      const push = await git(['push', 'origin', 'main']);
      if (push.code === 0) {
        return {
          ...result,
          pushed: true,
          summary: `数据已备份并推送到私人仓库${dirty ? '' : '（数据无变化，仅补推）'}：${remoteUrl}`,
        };
      }
      return {
        ...result,
        pushed: false,
        error: (push.stderr || push.stdout).trim().slice(-500),
        summary: `数据已备份到本地仓库${dirty ? '并提交' : '（数据无变化）'}，但推送到 ${remoteUrl} 未完成：${classifyPushError(push.stderr || push.stdout)}`,
      };
    } catch (err) {
      return { ...base, error: String(err.message || err), summary: `备份过程出错：${err.message || err}` };
    }
  };
  return (queue = queue.then(run, run));
}
