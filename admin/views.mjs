// Server-rendered HTML for the admin panel. Kept as template literals so the
// backend has no view-engine dependency. The markup + admin.css + admin.js give
// a small but complete CMS: dashboard, post/note editor with live preview,
// media library, and a build/publish console.
import { COLLECTIONS } from './lib/content.mjs';

export const esc = (v) =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const FIELD_META = {
  title: { label: '标题', type: 'text', placeholder: '文章标题' },
  description: { label: '描述', type: 'textarea', placeholder: '列表与 SEO 摘要（可选）' },
  cover: { label: '封面图', type: 'image', placeholder: '/covers/xxx.png 或 https://…' },
  main_color: { label: '主色调', type: 'text', placeholder: '如 #c96f4a（可选）' },
  author: { label: '作者', type: 'text', placeholder: '默认使用站点作者' },
  date: { label: '发布日期', type: 'date' },
  updated: { label: '更新日期', type: 'date' },
  categories: { label: '分类', type: 'tags', placeholder: '逗号分隔，如 技术,AI' },
  tags: { label: '标签', type: 'tags', placeholder: '逗号分隔' },
  keywords: { label: '关键词', type: 'tags', placeholder: '逗号分隔（SEO，可选）' },
  ai: { label: 'AI 摘要', type: 'tags', placeholder: '逗号分隔（可选）' },
  sticky: { label: '置顶权重', type: 'number', placeholder: '数字越大越靠前，留空不置顶' },
  mood: { label: '心情', type: 'text', placeholder: '如 夜、晴（可选）' },
  draft: { label: '存为草稿', type: 'bool' },
};

const FIELD_ORDER = {
  posts: ['title', 'date', 'updated', 'categories', 'tags', 'cover', 'sticky', 'draft', 'description', 'keywords', 'ai', 'main_color', 'author'],
  notes: ['date', 'title', 'mood', 'tags', 'draft'],
};

const asArray = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);

function renderField(name, value) {
  const meta = FIELD_META[name];
  if (!meta) return '';
  const val = value ?? '';
  switch (meta.type) {
    case 'textarea':
      return `<label class="field"><span class="field__label">${esc(meta.label)}</span><textarea class="input" data-field="${esc(name)}" rows="2" placeholder="${esc(meta.placeholder || '')}">${esc(val)}</textarea></label>`;
    case 'date':
      return `<label class="field"><span class="field__label">${esc(meta.label)}</span><input class="input" type="date" data-field="${esc(name)}" value="${esc(val)}" /></label>`;
    case 'number':
      return `<label class="field"><span class="field__label">${esc(meta.label)}</span><input class="input" type="number" data-field="${esc(name)}" value="${esc(val)}" placeholder="${esc(meta.placeholder || '')}" /></label>`;
    case 'tags':
      return `<label class="field"><span class="field__label">${esc(meta.label)}</span><input class="input" type="text" data-field="${esc(name)}" value="${esc(asArray(val).join(', '))}" placeholder="${esc(meta.placeholder || '')}" /></label>`;
    case 'image':
      return `<label class="field"><span class="field__label">${esc(meta.label)}</span><div class="field__row"><input class="input" type="text" data-field="${esc(name)}" id="field-${esc(name)}" value="${esc(val)}" placeholder="${esc(meta.placeholder || '')}" /><button type="button" class="btn btn--ghost" data-upload-target="field-${esc(name)}">上传</button></div></label>`;
    case 'bool':
      return `<label class="field field--inline"><input type="checkbox" data-field="${esc(name)}" ${val ? 'checked' : ''} /><span class="field__label">${esc(meta.label)}</span></label>`;
    default:
      return `<label class="field"><span class="field__label">${esc(meta.label)}</span><input class="input" type="text" data-field="${esc(name)}" value="${esc(val)}" placeholder="${esc(meta.placeholder || '')}" /></label>`;
  }
}

const NAV = [
  { href: '/admin', key: 'dashboard', label: '仪表盘', icon: '◈' },
  { href: '/admin/posts', key: 'posts', label: '文章', icon: '✎' },
  { href: '/admin/notes', key: 'notes', label: '随笔', icon: '☰' },
  { href: '/admin/media', key: 'media', label: '媒体', icon: '▣' },
  { href: '/admin/build', key: 'build', label: '构建发布', icon: '⟳' },
  { href: '/', key: 'site', label: '查看发布结果', icon: '⌂', external: true },
];

export function layout({ title, active, user, boot, content }) {
  const nav = NAV.map((item) => {
    const cls = item.key === active ? 'nav__item nav__item--active' : 'nav__item';
    const attrs = item.external ? ' target="_blank" rel="noopener"' : '';
    return `<a class="${cls}" href="${item.href}"${attrs}><span class="nav__icon">${item.icon}</span>${item.label}</a>`;
  }).join('\n        ');

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex, nofollow" />
  <title>${esc(title)} · 博客后台</title>
  <link rel="stylesheet" href="/admin-assets/admin.css" />
</head>
<body>
  <div class="app">
    <aside class="sidebar">
      <div class="brand"><span class="brand__mark">◆</span> 博客后台</div>
      <nav class="nav">
        ${nav}
      </nav>
      <div class="sidebar__foot">
        <span class="who">${esc(user)}</span>
        <button type="button" class="link" id="logout">退出登录</button>
      </div>
    </aside>
    <main class="main">
      ${content}
    </main>
  </div>
  <div class="toast" id="toast" hidden></div>
  <script>window.__BOOT__ = ${JSON.stringify(boot || {})}</script>
  <script src="/admin-assets/admin.js"></script>
</body>
</html>`;
}

export function loginPage({ csrfToken, error }) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex, nofollow" />
  <title>登录 · 博客后台</title>
  <link rel="stylesheet" href="/admin-assets/admin.css" />
</head>
<body class="login-body">
  <div class="login-card">
    <div class="brand"><span class="brand__mark">◆</span> 博客后台</div>
    <p class="login-sub">管理员登录</p>
    ${error ? `<div class="alert alert--error">${esc(error)}</div>` : ''}
    <form id="login-form" autocomplete="on">
      <label class="field"><span class="field__label">用户名</span><input class="input" type="text" name="username" autocomplete="username" required /></label>
      <label class="field"><span class="field__label">密码</span><input class="input" type="password" name="password" autocomplete="current-password" required /></label>
      <button class="btn btn--primary btn--block" type="submit">登录</button>
    </form>
  </div>
  <script>window.__BOOT__ = { csrfToken: ${JSON.stringify(csrfToken)} };</script>
  <script src="/admin-assets/admin.js"></script>
</body>
</html>`;
}

export function dashboardPage({ user, boot, stats, build }) {
  const cards = [
    { label: '文章', value: stats.posts, href: '/admin/posts' },
    { label: '随笔', value: stats.notes, href: '/admin/notes' },
    { label: '草稿', value: stats.drafts, href: '/admin/posts' },
    { label: '媒体文件', value: stats.media, href: '/admin/media' },
  ]
    .map(
      (c) => `<a class="stat" href="${c.href}"><span class="stat__value">${esc(c.value)}</span><span class="stat__label">${esc(c.label)}</span></a>`,
    )
    .join('\n');

  const buildState = build?.status || '尚未构建';
  const buildTime = build?.finishedAt ? new Date(build.finishedAt).toLocaleString('zh-CN') : '—';

  const content = `
    <header class="page__head"><h1>仪表盘</h1><p>内容以 Markdown 保存，发布即触发前台构建。</p></header>
    <div class="stats">${cards}</div>
    <section class="card">
      <h2 class="card__title">发布状态</h2>
      <div class="kv">
        <div><span>最近构建</span><strong>${esc(buildState)}</strong></div>
        <div><span>构建时间</span><strong>${esc(buildTime)}</strong></div>
        <div><span>当前版本</span><strong>${esc(build?.release || boot?.currentRelease || '—')}</strong></div>
      </div>
      <div class="actions">
        <a class="btn btn--primary" href="/admin/posts/new">写文章</a>
        <a class="btn" href="/admin/build">去发布</a>
      </div>
    </section>`;
  return layout({ title: '仪表盘', active: 'dashboard', user, boot, content });
}

export function listPage({ user, boot, collection, entries }) {
  const col = COLLECTIONS[collection];
  const rows = entries
    .map((e) => {
      const draft = e.data.draft ? '<span class="badge badge--draft">草稿</span>' : '<span class="badge badge--pub">已发布</span>';
      const date = e.data.date ? esc(e.data.date) : '—';
      const title = esc(e.data.title || e.id);
      return `<tr>
        <td class="cell-title"><a href="/admin/${collection}/edit?path=${encodeURIComponent(e.id)}">${title}</a></td>
        <td>${draft}</td>
        <td>${date}</td>
        <td class="cell-path"><code>${esc(e.id)}</code></td>
        <td class="cell-actions">
          <a class="btn btn--sm" href="/admin/${collection}/edit?path=${encodeURIComponent(e.id)}">编辑</a>
          <button type="button" class="btn btn--sm btn--danger" data-delete="${esc(e.id)}" data-collection="${collection}">删除</button>
        </td>
      </tr>`;
    })
    .join('\n');

  const content = `
    <header class="page__head page__head--row">
      <div><h1>${esc(col.label)}</h1><p>共 ${entries.length} 篇${collection === 'posts' ? '，URL 由路径决定' : ''}。</p></div>
      <a class="btn btn--primary" href="/admin/${collection}/new">新建${esc(col.label)}</a>
    </header>
    <div class="card">
      <table class="table">
        <thead><tr><th>标题</th><th>状态</th><th>日期</th><th>路径</th><th></th></tr></thead>
        <tbody>${rows || `<tr><td colspan="5" class="empty">还没有内容，点击右上角新建。</td></tr>`}</tbody>
      </table>
    </div>`;
  return layout({ title: col.label, active: collection, user, boot, content });
}

export function editorPage({ user, boot, collection, entry, isNew }) {
  const col = COLLECTIONS[collection];
  const data = entry?.data || {};
  const fields = FIELD_ORDER[collection].map((name) => renderField(name, data[name])).join('\n');
  const body = entry?.body || '';
  const id = entry?.id || '';

  const urlPrefix = collection === 'posts' ? '/posts/' : '/notes/';
  const title = isNew ? `新建${col.label}` : `编辑${col.label}`;

  const content = `
    <header class="page__head page__head--row">
      <div><h1>${esc(title)}</h1><p>${isNew ? '填写内容后保存，再到「构建发布」上线。' : '保存只写入文件，不会立即上线。'}</p></div>
      <div class="actions">
        <a class="btn" href="/admin/${collection}">返回列表</a>
        <button type="button" class="btn btn--primary" id="save-btn">保存</button>
      </div>
    </header>

    <div class="editor">
      <section class="card editor__form">
        <label class="field">
          <span class="field__label">路径 / slug</span>
          <input class="input" type="text" id="slug" value="${esc(id)}" placeholder="如 技术/my-post 或 20260928-hello" />
          <span class="field__hint">保存后 URL 为 <code id="url-preview">${esc(urlPrefix)}${esc(id)}/</code>。支持中文、字母、数字、点和连字符（用 / 分层），引号、空格等字符会自动替换为连字符。</span>
        </label>
        ${fields}
      </section>

      <section class="card editor__body">
        <div class="editor__body-head">
          <span class="field__label">正文（Markdown）</span>
          <div class="tabs">
            <button type="button" class="tab tab--active" data-tab="write">写作</button>
            <button type="button" class="tab" data-tab="preview">预览</button>
          </div>
        </div>
        <textarea id="body" class="body-area" spellcheck="false" placeholder="在这里写 Markdown 正文…">${esc(body)}</textarea>
        <div id="preview" class="preview prose" hidden></div>
      </section>
    </div>`;
  return layout({ title, active: collection, user, boot, content });
}

export function mediaPage({ user, boot, files }) {
  const items = files
    .map(
      (f) => `<div class="media-item">
        <img src="${esc(f.url)}" alt="${esc(f.name)}" loading="lazy" />
        <div class="media-item__meta">
          <code>${esc(f.url)}</code>
          <button type="button" class="btn btn--sm" data-copy="${esc(f.url)}">复制链接</button>
        </div>
      </div>`,
    )
    .join('\n');

  const content = `
    <header class="page__head"><h1>媒体</h1><p>上传到 public/uploads，构建时随站点一起发布。图片可直接插入正文。</p></header>
    <section class="card">
      <div class="upload-zone" id="upload-zone">
        <p>拖拽图片到此处，或</p>
        <label class="btn btn--primary"><input type="file" id="upload-input" accept="image/*" hidden />选择图片</label>
      </div>
    </section>
    <section class="media-grid">${items || '<p class="empty">还没有上传任何文件。</p>'}</section>`;
  return layout({ title: '媒体', active: 'media', user, boot, content });
}

export function buildPage({ user, boot, status, releases }) {
  const state = status?.status || '尚未构建';
  const finished = status?.finishedAt ? new Date(status.finishedAt).toLocaleString('zh-CN') : '—';
  const log = status?.log ? esc(status.log) : '（暂无构建日志）';
  const releaseRows = releases
    .map(
      (r) => `<li class="${r.current ? 'release release--current' : 'release'}">
        <code>${esc(r.name)}</code>
        ${r.current ? '<span class="badge badge--pub">当前</span>' : ''}
      </li>`,
    )
    .join('\n');

  const content = `
    <header class="page__head page__head--row">
      <div><h1>构建发布</h1><p>构建前台静态页面并原子切换，构建失败不影响线上。本地写作预览用 npm run dev（:4321，保存即热更新）；「查看发布结果」打开的才是构建产物。</p></div>
      <div class="actions">
        <button type="button" class="btn btn--primary" id="build-btn">构建并发布</button>
        <button type="button" class="btn" id="rollback-btn">回滚上一版</button>
      </div>
    </header>
    <section class="card">
      <div class="kv">
        <div><span>状态</span><strong id="build-state">${esc(state)}</strong></div>
        <div><span>完成时间</span><strong id="build-time">${esc(finished)}</strong></div>
      </div>
    </section>
    <section class="card">
      <h2 class="card__title">构建日志</h2>
      <pre class="log" id="build-log">${log}</pre>
    </section>
    <section class="card">
      <h2 class="card__title">历史版本</h2>
      <ul class="releases">${releaseRows || '<li class="empty">暂无发布版本。</li>'}</ul>
    </section>`;
  return layout({ title: '构建发布', active: 'build', user, boot, content });
}
