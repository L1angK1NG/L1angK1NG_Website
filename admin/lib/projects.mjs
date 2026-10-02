// 项目展示数据层：项目列表 + 项目详情，落在 data/projects.json。
// 项目正文支持 Markdown（详情页渲染），链接、技术栈、状态等为结构化字段。
import { marked } from 'marked';
import { readJSON, writeJSON, newId } from './store.mjs';

const PROJECTS_FILE = 'projects.json';
const EMPTY = { projects: [] };

const load = () => {
  const data = readJSON(PROJECTS_FILE, EMPTY);
  return { projects: Array.isArray(data.projects) ? data.projects : [] };
};
const save = (data) => writeJSON(PROJECTS_FILE, data);

const clean = (v, max) => String(v ?? '').trim().slice(0, max);

// slug 用作详情页 URL 段：白名单字符，其余替换为连字符（与内容 slug 净化一致）。
export function slugify(value) {
  return clean(value, 60)
    .toLowerCase()
    .replace(/[^a-z0-9一-龥-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
}

const normalizeProject = (p) => ({
  id: String(p?.id || ''),
  slug: String(p?.slug || '').slice(0, 80),
  title: clean(p?.title, 120),
  subtitle: clean(p?.subtitle, 200),
  description: clean(p?.description, 2000),
  cover: clean(p?.cover, 400),
  status: clean(p?.status, 20) || '已上线',
  tech: (Array.isArray(p?.tech) ? p.tech : []).map((t) => clean(t, 30)).filter(Boolean).slice(0, 12),
  links: (Array.isArray(p?.links) ? p.links : [])
    .map((l) => ({ label: clean(l?.label, 30), url: clean(l?.url, 300) }))
    .filter((l) => l.label && l.url)
    .slice(0, 6),
  featured: Boolean(p?.featured),
  order: Number(p?.order) || 0,
  content: String(p?.content ?? '').slice(0, 50000),
  createdAt: Number(p?.createdAt) || 0,
  updatedAt: Number(p?.updatedAt) || 0,
});

export function listProjects() {
  return load()
    .projects.map(normalizeProject)
    .sort((a, b) => (b.order - a.order) || (b.updatedAt - a.updatedAt));
}

export function getProject(idOrSlug) {
  const key = String(idOrSlug || '');
  const found = load().projects.find((p) => p.id === key || p.slug === key);
  return found ? normalizeProject(found) : null;
}

export function saveProject(input) {
  const data = load();
  const id = clean(input?.id, 40);
  const existing = id ? data.projects.find((p) => p.id === id) : null;

  const title = clean(input?.title, 120);
  if (!title) throw new Error('项目名称不能为空');

  let slug = slugify(input?.slug || title);
  if (!slug) slug = `project-${Date.now().toString(36)}`;
  // slug 冲突检查（同 slug 不允许出现两条）。
  const conflict = data.projects.find((p) => p.slug === slug && p.id !== id);
  if (conflict) throw new Error(`路径 ${slug} 已被其他项目占用`);

  const entry = normalizeProject({
    ...(existing || {}),
    id: existing?.id || newId(),
    slug,
    title,
    subtitle: input?.subtitle ?? existing?.subtitle,
    description: input?.description ?? existing?.description,
    cover: input?.cover ?? existing?.cover,
    status: input?.status ?? existing?.status,
    tech: input?.tech ?? existing?.tech,
    links: input?.links ?? existing?.links,
    featured: input?.featured ?? existing?.featured,
    order: input?.order ?? existing?.order,
    content: input?.content ?? existing?.content,
    createdAt: existing?.createdAt || Date.now(),
    updatedAt: Date.now(),
  });

  if (existing) Object.assign(existing, entry);
  else data.projects.push(entry);
  save(data);
  return entry;
}

export function deleteProject(id) {
  const data = load();
  const next = data.projects.filter((p) => p.id !== String(id));
  if (next.length === data.projects.length) throw new Error('项目不存在');
  data.projects = next;
  save(data);
  return { ok: true };
}

// 项目详情的 Markdown → HTML（管理员自己写的内容，构建/展示时渲染）。
export function renderProjectContent(markdown) {
  return String(marked.parse(String(markdown ?? ''), { async: false, gfm: true, breaks: false }));
}
