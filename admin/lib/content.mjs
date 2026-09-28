// File-backed content store for posts and notes. Content stays as Markdown with
// YAML frontmatter under src/content/, so the Astro build (and its shortcodes,
// search index, RSS) keeps working unchanged — the admin simply writes files.
//
// Each entry is identified by its path relative to the collection folder, minus
// the .md extension (e.g. "技术/deploy-static"). That path becomes the post URL.
import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { ROOT } from './env.mjs';

const CONTENT_ROOT = path.join(ROOT, 'src', 'content');

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
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

const isEmpty = (v) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);

// Resolve an entry id to a real file path, refusing anything that would escape
// the collection folder (ids come from URLs and form input).
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

// Slugs double as filenames and URLs. Windows forbids < > : " | ? * in names
// (a stray quote makes the write fail with ENOENT), and characters like quotes,
// spaces or % produce broken URLs on any OS — so everything outside a
// conservative whitelist becomes a hyphen. Segments are also trimmed of edge
// dots/hyphens: Windows drops trailing dots when creating directories, and
// dot-leading files are invisible to the content glob.
const safeSegment = (segment) =>
  segment
    .replace(/[^A-Za-z0-9_\u4e00-\u9fa5.\-]+/g, '-')
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
  // Newest first; ties broken by title, mirroring the blog's sort.
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

// Build the frontmatter object for serialization. Existing unknown fields (e.g.
// ai, main_color) are preserved so an edit never strips data the form omits.
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
      // Keep the frontmatter clean: only record draft when it's actually a draft.
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

// Save an entry. `id` locates it; `input` carries form fields; `body` is the
// Markdown. When `originalId` is set and differs from `id`, the file is moved
// (used for renaming / re-slugging).
export function saveEntry(collectionName, id, input, body, originalId) {
  const cleanId = sanitizeId(id);
  if (!cleanId) {
    throw new Error('路径无效：请至少包含中文、字母或数字');
  }
  const target = resolveFile(collectionName, cleanId);
  const col = target.col;
  const renaming = Boolean(originalId) && originalId !== cleanId;
  const source = renaming ? resolveFile(collectionName, originalId) : null;

  // A brand-new entry must not clobber an existing file at the same path.
  if (!originalId && fs.existsSync(target.filePath)) {
    throw new Error('该路径已存在内容，请换一个路径');
  }
  // Renaming onto a path already used by a different entry is also a conflict.
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
  fs.unlinkSync(filePath);
}

// A slug suggestion for new entries: date-prefixed ASCII-ish path. The user can
// override it in the form; Chinese slugs are allowed too (they match the
// existing site URLs like /posts/技术/deploy-static/).
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
