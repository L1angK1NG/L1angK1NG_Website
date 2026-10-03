// 动态数据的 JSON 文件存储（data/ 目录）。
//
// 与 src/content/ 的 Markdown 不同，这里的运行时数据（评论、友链、歌单、公告、
// 访问统计）由后台服务直接读写、即时生效，无需重新构建前台。写入采用
// 「临时文件 + 原子重命名」，避免断电/崩溃留下半截 JSON。
//
// 并发一致性：同一文件的「读-改-写」必须串行，否则两个并发请求各自读到旧值
// 后先后写回，会丢失一次计数/评论。公开热接口统一走 updateJSON（异步 + 文件级
// 互斥队列）；同步 readJSON/writeJSON 仅保留给冷路径（后台页面渲染、构建状态）。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { ROOT } from './env.mjs';

// 数据目录默认在项目 data/ 下；测试可用 BLOG_DATA_DIR 指向临时目录隔离。
export const DATA_DIR = process.env.BLOG_DATA_DIR
  ? path.resolve(process.env.BLOG_DATA_DIR)
  : path.join(ROOT, 'data');
export const MUSIC_FILES_DIR = path.join(DATA_DIR, 'music-files');

// 读取 JSON 数据文件；文件不存在或损坏时返回 fallback 的深拷贝，
// 保证任何模块都不会因为数据文件缺失而崩溃。
export function readJSON(name, fallback) {
  try {
    const file = path.join(DATA_DIR, name);
    if (!fs.existsSync(file)) return structuredClone(fallback);
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return structuredClone(fallback);
  }
}

export function writeJSON(name, value) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const file = path.join(DATA_DIR, name);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

// —— 异步读写 + 文件级互斥 ——
export async function readJSONAsync(name, fallback) {
  try {
    const file = path.join(DATA_DIR, name);
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return structuredClone(fallback);
  }
}

export async function writeJSONAsync(name, value) {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  const file = path.join(DATA_DIR, name);
  const tmp = `${file}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
  await fsp.rename(tmp, file);
}

// 每个数据文件一条 Promise 链：后到的读-改-写排队执行（参考 backup.mjs 的
// 串行队列）。前一个任务失败不阻塞后续任务。
const fileLocks = new Map();

export function withFileLock(name, task) {
  const prev = fileLocks.get(name) || Promise.resolve();
  const run = prev.then(task, task);
  fileLocks.set(name, run.then(() => {}, () => {}));
  return run;
}

// 在互斥保护下读-改-写一个数据文件：mutate 直接修改传入的数据对象，
// 返回值透传给调用方。这是评论/统计/友链等公开写接口的唯一入口。
export function updateJSON(name, fallback, mutate) {
  return withFileLock(name, async () => {
    const data = await readJSONAsync(name, fallback);
    const result = await mutate(data);
    await writeJSONAsync(name, data);
    return result === undefined ? data : result;
  });
}

// 短随机 ID，用于评论 / 友链 / 曲目 / 公告的主键。
export const newId = () => crypto.randomBytes(8).toString('hex');

// —— 通用限流器（按 IP 的固定窗口计数，内存态） ——
// 公开写接口（评论、友链申请、访问打点）都要过这一层，防止脚本刷爆数据文件。
const buckets = new Map();

export function rateLimit(req, { key, max, windowMs }) {
  const client = req.ip || req.socket?.remoteAddress || 'unknown';
  const now = Date.now();
  const slot = `${key}|${client}`;
  const rec = buckets.get(slot);
  if (!rec || now - rec.start > windowMs) {
    buckets.set(slot, { start: now, count: 1 });
    return { ok: true };
  }
  rec.count += 1;
  if (rec.count > max) {
    return { ok: false, retryAfter: Math.ceil((rec.start + windowMs - now) / 1000) };
  }
  return { ok: true };
}

// 定期清理过期的限流桶，避免长时间运行后内存无限增长。
setInterval(() => {
  const now = Date.now();
  for (const [slot, rec] of buckets) {
    if (now - rec.start > 60 * 60 * 1000) buckets.delete(slot);
  }
}, 10 * 60 * 1000).unref?.();
