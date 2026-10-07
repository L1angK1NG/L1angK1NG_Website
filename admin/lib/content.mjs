// 基于文件的文章与随笔内容存储。内容仍以带 YAML frontmatter 的 Markdown 形式
// 保存在 src/content/ 下，因此 Astro 构建（及其短代码、搜索索引、RSS）无需
// 任何改动即可继续工作 —— 管理后台只是负责写入文件。
//
// 每个条目由相对于集合文件夹的路径标识（去掉 .md 扩展名，例如
// "技术/deploy-static"）。该路径即为文章的 URL。
import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { ROOT } from './env.mjs';
import { DATA_DIR } from './store.mjs';

const CONTENT_ROOT = path.join(ROOT, 'src', 'content');
// 回收站：删除的内容移入 data/trash/（个人数据，不进 git、不被 Astro 构建扫到），
// 文件名记录删除时间与原路径，可恢复或彻底删除。
const TRASH_ROOT = path.join(DATA_DIR, 'trash');

export const COLLECTIONS = {
  posts: {
    dir: path.join(CONTENT_ROOT, 'posts'),
    label: '文章',
    textFields: ['title', 'description', 'cover', 'main_color', 'author'],
    dateFields: ['date', 'updated'],
    listFields: ['categories', 'tags', 'keywords', 'ai'],
    numberFields: ['sticky'],
    boolFields: ['draft'],
    requireTitle: true,
  },
  notes: {
    dir: path.join(CONTENT_ROOT, 'notes'),
    label: '随笔',
    textFields: ['title', 'mood'],
    dateFields: ['date'],
    listFields: ['tags'],
    numberFields: [],
    boolFields: ['draft'],
    requireTitle: false,
  },
};

const toDateInput = (value) => {
  if (!value) return '';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  // 保留分钟精度（编辑器的日期时间选择器可精确到分）；00:00 时只存日期，
  // 与既有内容格式保持兼容。
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return time === '00:00' ? date : `${date} ${time}`;
};

const isEmpty = (v) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);

// 将条目 id 解析为真实的文件路径，拒绝任何会逃出集合文件夹的取值
// （id 来自 URL 和表单输入）。
function resolveFile(collectionName, id) {
  const col = COLLECTIONS[collectionName];
  if (!col) throw new Error('未知的内容类型');
  const safeId = String(id || '').replace(/\\/g, '/').replace(/\.md$/i, '');
  if (!safeId || safeId.includes('..') || path.isAbsolute(safeId) || safeId.startsWith('/')) {
    throw new Error('非法的内容路径');
  }
  const filePath = path.join(col.dir, safeId + '.md');
  const rel = path.relative(col.dir, filePath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('非法的内容路径');
  }
  return { col, id: safeId, filePath };
}

// slug 同时用作文件名和 URL。Windows 禁止文件名中出现 < > : " | ? *（夹带一
// 个引号就会让写入失败并报 ENOENT），而引号、空格或 % 之类的字符在任何操作
// 系统上都会产生损坏的 URL —— 因此保守白名单之外的所有字符一律替换为连字符。
// 每一段还会去掉首尾的点/连字符：Windows 创建目录时会丢弃末尾的点，而以点
// 开头的文件对内容 glob 来说不可见。
const safeSegment = (segment) =>
  segment
    .replace(/[^A-Za-z0-9_\u4e00-\u9fa5.-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/^[-.]+|[-.]+$/g, '');

export function sanitizeId(id) {
  const segments = String(id || '')
    .replace(/\\/g, '/')
    .replace(/\.md$/i, '')
    .split('/')
    .map(safeSegment)
    .filter(Boolean);
  return segments.join('/');
}

function walkMarkdown(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkMarkdown(full));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      out.push(full);
    }
  }
  return out;
}

const idFromFile = (col, filePath) =>
  path.relative(col.dir, filePath).replace(/\\/g, '/').replace(/\.md$/i, '');

function normalizeData(col, data) {
  const out = { ...data };
  for (const field of col.dateFields) {
    if (field in out) {
      const formatted = toDateInput(out[field]);
      if (formatted) out[field] = formatted;
      else delete out[field];
    }
  }
  return out;
}

function readEntry(collectionName, filePath) {
  const col = COLLECTIONS[collectionName];
  const raw = fs.readFileSync(filePath, 'utf8');
  const parsed = matter(raw);
  return {
    id: idFromFile(col, filePath),
    filePath,
    data: normalizeData(col, parsed.data),
    body: parsed.content.replace(/^\n+/, ''),
    raw,
  };
}

export function listEntries(collectionName) {
  const col = COLLECTIONS[collectionName];
  if (!col) throw new Error('未知的内容类型');
  const entries = walkMarkdown(col.dir).map((f) => readEntry(collectionName, f));
  // 最新的排在前面；日期相同时按标题决胜，与博客的排序逻辑一致。
  entries.sort((a, b) => {
    const da = a.data.date ? new Date(a.data.date).getTime() : 0;
    const db = b.data.date ? new Date(b.data.date).getTime() : 0;
    if (db !== da) return db - da;
    return String(a.data.title || a.id).localeCompare(String(b.data.title || b.id), 'zh-CN');
  });
  return entries;
}

export function getEntry(collectionName, id) {
  const { filePath } = resolveFile(collectionName, id);
  if (!fs.existsSync(filePath)) return null;
  return readEntry(collectionName, filePath);
}

export function entryExists(collectionName, id) {
  const { filePath } = resolveFile(collectionName, id);
  return fs.existsSync(filePath);
}

// 构建用于序列化的 frontmatter 对象。已存在的未知字段（例如 ai、main_color）
// 会被保留，这样编辑时绝不会丢掉表单未覆盖的数据。
function buildData(col, existing, input) {
  const data = { ...existing };
  for (const field of col.textFields) {
    if (field in input) {
      const v = input[field];
      if (isEmpty(v)) delete data[field];
      else data[field] = String(v).trim();
    }
  }
  for (const field of col.dateFields) {
    if (field in input) {
      const v = input[field];
      if (isEmpty(v)) delete data[field];
      else {
        const d = new Date(v);
        if (Number.isNaN(d.getTime())) throw new Error(`字段 ${field} 的日期格式无效`);
        data[field] = toDateInput(d);
      }
    }
  }
  for (const field of col.listFields) {
    if (field in input) {
      const raw = input[field];
      const arr = (Array.isArray(raw) ? raw : String(raw ?? '').split(/[,，]/))
        .map((s) => String(s).trim())
        .filter(Boolean);
      if (arr.length === 0) delete data[field];
      else data[field] = [...new Set(arr)];
    }
  }
  for (const field of col.numberFields) {
    if (field in input) {
      const v = input[field];
      if (isEmpty(v)) delete data[field];
      else {
        const n = Number(v);
        if (Number.isNaN(n)) throw new Error(`字段 ${field} 必须是数字`);
        data[field] = n;
      }
    }
  }
  for (const field of col.boolFields) {
    if (field in input) {
      const v = input[field] === true || input[field] === 'true' || input[field] === 'on';
      // 保持 frontmatter 简洁：只有确实是草稿时才写入 draft 字段。
      if (v) data[field] = true;
      else delete data[field];
    }
  }
  return data;
}

export function validateEntry(col, data) {
  if (col.requireTitle && !String(data.title || '').trim()) {
    return '标题不能为空';
  }
  if ('date' in data && data.date) {
    const d = new Date(data.date);
    if (Number.isNaN(d.getTime())) return '日期格式无效';
  }
  return null;
}

// 保存条目。`id` 用于定位条目；`input` 携带表单字段；`body` 是 Markdown 正文。
// 当 `originalId` 已设置且与 `id` 不同时，文件会被移动（用于重命名/更改 slug）。
export function saveEntry(collectionName, id, input, body, originalId) {
  const cleanId = sanitizeId(id);
  if (!cleanId) {
    throw new Error('路径无效：请至少包含中文、字母或数字');
  }
  const target = resolveFile(collectionName, cleanId);
  const col = target.col;
  const renaming = Boolean(originalId) && originalId !== cleanId;
  const source = renaming ? resolveFile(collectionName, originalId) : null;

  // 全新条目不得覆盖同一路径下已有的文件。
  if (!originalId && fs.existsSync(target.filePath)) {
    throw new Error('该路径已存在内容，请换一个路径');
  }
  // 重命名到已被其他条目占用的路径同样视为冲突。
  if (renaming && fs.existsSync(target.filePath) && target.filePath !== source.filePath) {
    throw new Error('目标路径已被占用，请换一个路径');
  }

  const readFrom = source && fs.existsSync(source.filePath) ? source.filePath : target.filePath;
  const existing = fs.existsSync(readFrom) ? readEntry(collectionName, readFrom).data : {};

  const data = buildData(col, existing, input);
  const err = validateEntry(col, data);
  if (err) throw new Error(err);

  fs.mkdirSync(path.dirname(target.filePath), { recursive: true });
  const output = matter.stringify(String(body ?? '').replace(/^\n+/, ''), data);
  fs.writeFileSync(target.filePath, output, 'utf8');

  if (source && fs.existsSync(source.filePath)) {
    fs.unlinkSync(source.filePath);
  }

  return readEntry(collectionName, target.filePath);
}

export function deleteEntry(collectionName, id) {
  const { filePath } = resolveFile(collectionName, id);
  if (!fs.existsSync(filePath)) throw new Error('内容不存在');
  // 移入回收站而不是直接删文件：文件名形如 <删除时间戳>__<encodeURIComponent(原路径)>.md，
  // 编码保证斜杠等字符不会产生子目录，恢复时可精确还原原路径。
  const trashDir = path.join(TRASH_ROOT, collectionName);
  fs.mkdirSync(trashDir, { recursive: true });
  const trashName = `${Date.now()}__${encodeURIComponent(id)}.md`;
  const trashPath = path.join(trashDir, trashName);
  try {
    fs.renameSync(filePath, trashPath);
  } catch {
    // 跨磁盘移动失败时退化为复制 + 删除。
    fs.copyFileSync(filePath, trashPath);
    fs.unlinkSync(filePath);
  }
  return { ok: true, trash: trashName };
}

// —— 回收站管理 ——
const trashFileOf = (collectionName, file) => {
  const name = path.basename(String(file || ''));
  if (!/^\d+__.+\.md$/.test(name)) throw new Error('回收站条目无效');
  const full = path.join(TRASH_ROOT, collectionName, name);
  if (!fs.existsSync(full)) throw new Error('回收站条目不存在');
  return full;
};

export function listTrash(collectionName) {
  if (!COLLECTIONS[collectionName]) throw new Error('未知的内容类型');
  const dir = path.join(TRASH_ROOT, collectionName);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && /^\d+__.+\.md$/.test(e.name))
    .map((e) => {
      const ts = Number(e.name.split('__')[0]) || 0;
      let id = '';
      let title = '';
      try {
        id = decodeURIComponent(e.name.slice(e.name.indexOf('__') + 2, -3));
        title = matter(fs.readFileSync(path.join(dir, e.name), 'utf8')).data?.title || '';
      } catch {
        /* 损坏条目按无标题展示 */
      }
      return { file: e.name, id, title, deletedAt: ts };
    })
    .sort((a, b) => b.deletedAt - a.deletedAt);
}

export function trashCount(collectionName) {
  return listTrash(collectionName).length;
}

export function restoreTrash(collectionName, file) {
  const full = trashFileOf(collectionName, file);
  const id = decodeURIComponent(path.basename(full).slice(path.basename(full).indexOf('__') + 2, -3));
  const target = resolveFile(collectionName, id);
  if (fs.existsSync(target.filePath)) {
    throw new Error(`原路径 ${id} 已被占用，请先处理同名内容再恢复`);
  }
  fs.mkdirSync(path.dirname(target.filePath), { recursive: true });
  try {
    fs.renameSync(full, target.filePath);
  } catch {
    // 数据目录与内容目录不同盘（如 BLOG_DATA_DIR 在别的磁盘）时 rename 会
    // 报 EXDEV，退化为复制 + 删除。
    fs.copyFileSync(full, target.filePath);
    fs.unlinkSync(full);
  }
  return { ok: true, id };
}

export function purgeTrash(collectionName, file) {
  const full = trashFileOf(collectionName, file);
  fs.unlinkSync(full);
  return { ok: true };
}

export function purgeAllTrash(collectionName) {
  if (!COLLECTIONS[collectionName]) throw new Error('未知的内容类型');
  const dir = path.join(TRASH_ROOT, collectionName);
  if (!fs.existsSync(dir)) return { ok: true, removed: 0 };
  const files = fs.readdirSync(dir).filter((n) => /^\d+__.+\.md$/.test(n));
  for (const n of files) fs.unlinkSync(path.join(dir, n));
  return { ok: true, removed: files.length };
}

// 为新条目生成 slug 建议：以日期为前缀、接近 ASCII 风格的路径。用户可以在
// 表单中自行修改；也允许使用中文 slug（与站内现有的 /posts/技术/deploy-static/
// 这类 URL 保持一致）。
export function suggestId(collectionName, title, dateInput) {
  const date = dateInput ? new Date(dateInput) : new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = Number.isNaN(date.getTime())
    ? new Date()
    : date;
  const prefix = `${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}`;
  const base = String(title || 'untitled')
    .trim()
    .toLowerCase()
    .replace(/[^\w一-龥-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return collectionName === 'notes' ? prefix : `${prefix}-${base || 'untitled'}`;
}
