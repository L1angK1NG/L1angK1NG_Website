// Build orchestration: run `astro build`, then atomically publish the output so
// the live site never serves a half-built page.
//
// Layout produced here:
//   dist/               Astro build output (fresh on every build)
//   releases/<ts>/      published snapshots
//   current  -> releases/<ts>   the directory nginx serves
//
// On success dist/ is renamed into releases/<ts> and the `current` link flips in
// one atomic step. On failure the running site (current) is left untouched.
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
const LOG_LIMIT = 200_000; // keep at most ~200KB of build output

const rmrf = (p) => {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
};

// Astro's content-layer cache is not pruned when a source file is deleted, so a
// rebuild can keep emitting removed posts. The fix is to wipe the cache so the
// build rescans src/content/ — but wiping it also destroys the state of a
// concurrently running `npm run dev`, which shares the same files. Additions
// and edits ARE picked up without any wipe, so the cache is only cleared when a
// deletion actually happened. Deletions are detected with our own manifest of
// the content files the last build saw — deliberately NOT by parsing Astro's
// internal data-store, whose format is an implementation detail.
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

// True when a content file that the last build saw has since been deleted.
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
    /* ignore */
  }
}

function acquireLock() {
  try {
    fs.mkdirSync(LOCK_DIR);
    try {
      fs.writeFileSync(path.join(LOCK_DIR, 'pid'), String(process.pid));
    } catch {
      /* ignore */
    }
    return true;
  } catch (e) {
    if (e.code === 'EEXIST') {
      let age = 0;
      try {
        age = Date.now() - fs.statSync(LOCK_DIR).mtimeMs;
      } catch {
        /* ignore */
      }
      // A crashed build shouldn't block publishing forever.
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
    // shell: npm is a .cmd on Windows and Node's spawn refuses to run .cmd
    // without a shell (EINVAL). The command is static (no user input), so a
    // shell here introduces no injection risk and works on Linux too.
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
    // Windows rename can't replace an existing dir link; remove first (dev only).
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
    /* ignore */
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

// Build the site and publish it. Resolves with { ok, log, release, message }.
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

// Repoint `current` at the previous release. Returns the release rolled back to.
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
