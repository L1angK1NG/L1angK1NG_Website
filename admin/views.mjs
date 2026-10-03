// 后台面板的服务端渲染 HTML。使用模板字符串编写，使后端不依赖任何视图引擎。
// 这些标记 + admin.css + admin.js 组成了一个小而完整的 CMS：仪表盘、带实时
// 预览的文章/随笔编辑器、媒体库，以及构建/发布控制台。
import { COLLECTIONS } from './lib/content.mjs';
import { stripAnsi } from './lib/build.mjs';

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
  { href: '/admin/projects', key: 'projects', label: '项目', icon: '◆' },
  { href: '/admin/nav-links', key: 'nav-links', label: '网址导航', icon: '⌘' },
  { href: '/admin/friends', key: 'friends', label: '友链', icon: '❋' },
  { href: '/admin/music', key: 'music', label: '音乐', icon: '♪' },
  { href: '/admin/announcements', key: 'announcements', label: '公告', icon: '▤' },
  { href: '/admin/comments', key: 'comments', label: '评论', icon: '✦' },
  { href: '/admin/site-content', key: 'site-content', label: '页面内容', icon: '❏' },
  { href: '/admin/stats', key: 'stats', label: '访问统计', icon: '◔' },
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
    <div class="alert alert--error" id="login-error"${error ? '' : ' hidden'} role="alert">
      <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-6h2v6z"/></svg>
      <span id="login-error-msg">${esc(error || '')}</span>
    </div>
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
          <div class="media-item__actions">
            <button type="button" class="btn btn--sm" data-copy="${esc(f.url)}">复制链接</button>
            <button type="button" class="btn btn--sm btn--danger" data-media-delete="${esc(f.name)}">删除</button>
          </div>
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

export function buildPage({ user, boot, status, releases, backupConfig }) {
  const state = status?.status || '尚未构建';
  const finished = status?.finishedAt ? new Date(status.finishedAt).toLocaleString('zh-CN') : '—';
  // 剥一遍 ANSI：修复前存下的旧日志里可能还带着转义序列
  const log = status?.log ? esc(stripAnsi(status.log)) : '（暂无构建日志）';
  const releaseRows = releases
    .map(
      (r) => `<li class="${r.current ? 'release release--current' : 'release'}">
        <code>${esc(r.name)}</code>
        ${r.current ? '<span class="badge badge--pub">当前</span>' : ''}
      </li>`,
    )
    .join('\n');

  const bk = backupConfig || {};
  const backupCard = `
    <section class="card">
      <h2 class="card__title">数据备份</h2>
      <p>每次「构建并发布」成功后，自动把个人数据（文章随笔、上传媒体、动态数据、头像、.env）直接推送到上面的私人仓库（建议 GitHub 私有仓库），全程使用系统临时目录、本地不留备份缓存；推送失败不影响发布，下次发布自动重试。留空则使用默认地址（主仓库地址 + <code>-backup</code>）。</p>
      <div class="field__row">
        <input class="input" id="backup-remote" value="${esc(bk.remoteUrl || '')}" placeholder="https://github.com/用户名/仓库名.git" spellcheck="false" />
        <button type="button" class="btn" id="backup-save">保存仓库地址</button>
      </div>
      <p>当前生效：<code id="backup-effective">${esc(bk.effective || '（未配置，暂不备份）')}</code>（来源：${esc(bk.sourceLabel || '未配置')}）</p>
      <p>上次备份：${esc(status?.backup?.summary || '尚未执行')}</p>
    </section>`;

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
    ${backupCard}
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

// ============ 动态模块管理页面 ============

// —— 页面内容（主页 hero + 关于页 + 页脚合并编辑） ——
export function siteContentPage({ user, boot, profile }) {
  const hero = profile.hero;
  const about = profile.about;
  const footer = profile.footer;

  const socialRows = (list, ns) =>
    list
      .map(
        (s, i) => `<div class="kv-row" data-social="${ns}" data-index="${i}">
        <input class="input" data-sfield="icon" value="${esc(s.icon)}" placeholder="图标名 如 bilibili" />
        <input class="input" data-sfield="label" value="${esc(s.label)}" placeholder="显示名" />
        <input class="input" data-sfield="href" value="${esc(s.href)}" placeholder="链接地址" />
        <button type="button" class="btn btn--sm btn--danger" data-social-remove="${ns}" data-index="${i}">删</button>
      </div>`,
      )
      .join('\n');

  const content = `
    <header class="page__head page__head--row">
      <div><h1>页面内容</h1><p>主页「你好……」首屏、关于页文案与页脚在这里统一编辑，保存后到「构建发布」上线。</p></div>
      <button type="button" class="btn btn--primary" id="profile-save">保存</button>
    </header>

    <section class="card">
      <h2 class="card__title">主页首屏</h2>
      <label class="field"><span class="field__label">眉标（小字）</span><input class="input" id="p-hero-eyebrow" value="${esc(hero.eyebrow)}" /></label>
      <label class="field"><span class="field__label">主标题</span><input class="input" id="p-hero-title" value="${esc(hero.title)}" /></label>
      <label class="field"><span class="field__label">简介</span><textarea class="input" id="p-hero-bio" rows="3">${esc(hero.bio)}</textarea></label>
      <div class="field__row">
        <label class="field" style="flex:1"><span class="field__label">按钮文字</span><input class="input" id="p-hero-action-label" value="${esc(hero.actionLabel)}" /></label>
        <label class="field" style="flex:2"><span class="field__label">按钮链接</span><input class="input" id="p-hero-action-href" value="${esc(hero.actionHref)}" /></label>
      </div>
      <div class="field">
        <span class="field__label">社交链接</span>
        <div id="p-hero-socials">${socialRows(hero.socials, 'hero')}</div>
        <button type="button" class="btn btn--sm" data-social-add="hero">+ 添加社交链接</button>
      </div>
    </section>

    <section class="card">
      <h2 class="card__title">关于页</h2>
      <label class="field"><span class="field__label">主旨句（支持 &lt;em&gt; 强调）</span><textarea class="input" id="p-about-lead" rows="2">${esc(about.lead)}</textarea></label>
      <label class="field"><span class="field__label">正文段落（每行一段）</span><textarea class="input" id="p-about-subs" rows="4">${esc(about.subs.join('\n'))}</textarea></label>
      <label class="field"><span class="field__label">速览标签（每行一条）</span><textarea class="input" id="p-about-facts" rows="3">${esc(about.facts.join('\n'))}</textarea>
        <span class="field__hint">文章数、起始年份等由构建自动追加，此处只填自定义标签。</span></label>
      <div class="field">
        <span class="field__label">社交链接</span>
        <div id="p-about-socials">${socialRows(about.socials, 'about')}</div>
        <button type="button" class="btn btn--sm" data-social-add="about">+ 添加社交链接</button>
      </div>
    </section>

    <section class="card">
      <h2 class="card__title">页脚</h2>
      <div class="field__row">
        <label class="field" style="flex:1"><span class="field__label">头像旁标语</span><input class="input" id="p-footer-tagline" value="${esc(footer.tagline)}" /></label>
        <label class="field" style="flex:1"><span class="field__label">版权文字（{year} {author} 自动替换）</span><input class="input" id="p-footer-copyright" value="${esc(footer.copyright)}" /></label>
      </div>
      <label class="field"><span class="field__label">归属文字（支持 &lt;a href="…"&gt;、&lt;em&gt;、&lt;strong&gt;，其余标签会被转为纯文本）</span><textarea class="input" id="p-footer-attribution" rows="2">${esc(footer.attribution)}</textarea></label>
      <div class="field">
        <span class="field__label">页脚链接（链接留空则显示为纯文字胶囊；可用图标与社交链接相同）</span>
        <div id="p-footer-socials">${socialRows(footer.links, 'footer')}</div>
        <button type="button" class="btn btn--sm" data-social-add="footer">+ 添加页脚链接</button>
      </div>
    </section>`;
  return layout({ title: '页面内容', active: 'site-content', user, boot, content });
}

// —— 项目管理 ——
export function projectsPage({ user, boot, projects }) {
  const rows = projects
    .map(
      (p) => `<tr>
        <td class="cell-title"><button type="button" class="link" data-project-edit="${esc(p.id)}">${esc(p.title)}</button></td>
        <td><code>${esc(p.slug)}</code></td>
        <td>${esc(p.status)}${p.featured ? ' <span class="badge badge--pub">精选</span>' : ''}</td>
        <td>${esc(p.tech.join('、') || '—')}</td>
        <td class="cell-actions">
          <button type="button" class="btn btn--sm" data-project-edit="${esc(p.id)}">编辑</button>
          <button type="button" class="btn btn--sm btn--danger" data-project-delete="${esc(p.id)}">删除</button>
        </td>
      </tr>`,
    )
    .join('\n');

  const content = `
    <header class="page__head page__head--row">
      <div><h1>项目</h1><p>前台「项目」页的列表与详情内容。保存后到「构建发布」上线（构建后生效）。</p></div>
      <button type="button" class="btn btn--primary" id="project-new">新建项目</button>
    </header>

    <div class="card">
      <table class="table">
        <thead><tr><th>名称</th><th>路径</th><th>状态</th><th>技术栈</th><th></th></tr></thead>
        <tbody id="project-rows">${rows || '<tr><td colspan="5" class="empty">还没有项目，点击右上角新建。</td></tr>'}</tbody>
      </table>
    </div>

    <section class="card" id="project-editor" hidden>
      <h2 class="card__title" id="project-editor-title">新建项目</h2>
      <input type="hidden" id="pj-id" />
      <div class="field__row">
        <label class="field" style="flex:2"><span class="field__label">项目名称 *</span><input class="input" id="pj-title" /></label>
        <label class="field" style="flex:1"><span class="field__label">路径 slug</span><input class="input" id="pj-slug" placeholder="留空自动生成" /></label>
      </div>
      <label class="field"><span class="field__label">一句话简介</span><input class="input" id="pj-subtitle" /></label>
      <label class="field"><span class="field__label">详细描述</span><textarea class="input" id="pj-description" rows="3"></textarea></label>
      <div class="field__row">
        <label class="field" style="flex:2"><span class="field__label">封面图</span>
          <div class="field__row"><input class="input" id="pj-cover" placeholder="/uploads/xxx.png 或 https://…" /><button type="button" class="btn btn--ghost" data-upload-target="pj-cover">上传</button></div>
        </label>
        <label class="field" style="flex:1"><span class="field__label">状态</span><input class="input" id="pj-status" placeholder="如 已上线 / 开发中 / 已归档" /></label>
      </div>
      <div class="field__row">
        <label class="field" style="flex:2"><span class="field__label">技术栈（逗号分隔）</span><input class="input" id="pj-tech" placeholder="Astro, Node.js, …" /></label>
        <label class="field" style="flex:1"><span class="field__label">排序（越大越靠前）</span><input class="input" type="number" id="pj-order" value="0" /></label>
        <label class="field field--inline" style="align-self:flex-end;margin-bottom:16px"><input type="checkbox" id="pj-featured" /><span class="field__label">精选展示</span></label>
      </div>
      <label class="field"><span class="field__label">项目链接（每行一条：文字|地址）</span>
        <textarea class="input" id="pj-links" rows="3" placeholder="GitHub|https://github.com/…&#10;在线预览|https://…"></textarea></label>
      <label class="field"><span class="field__label">详情正文（Markdown）</span><textarea class="input body-area" id="pj-content" rows="10" placeholder="项目详细介绍，支持 Markdown。"></textarea></label>
      <div class="actions">
        <button type="button" class="btn btn--primary" id="project-save">保存项目</button>
        <button type="button" class="btn" id="project-cancel">收起</button>
      </div>
    </section>`;
  return layout({ title: '项目', active: 'projects', user, boot: { ...boot, projects }, content });
}

// —— 网址导航管理 ——
export function navLinksPage({ user, boot, nav }) {
  const cats = nav.categories
    .map(
      (cat, ci) => `<div class="navcat" data-cat-index="${ci}">
        <div class="navcat__head">
          <input class="input navcat__name" value="${esc(cat.name)}" placeholder="分类名" />
          <button type="button" class="btn btn--sm btn--danger" data-cat-remove="${ci}">删除分类</button>
        </div>
        <div class="navcat__links">
          ${cat.links
            .map(
              (l, li) => `<div class="kv-row" data-cat-link="${ci}" data-link-index="${li}">
                <input class="input" data-lfield="name" value="${esc(l.name)}" placeholder="网站名" />
                <input class="input" data-lfield="url" value="${esc(l.url)}" placeholder="https://…" />
                <input class="input" data-lfield="desc" value="${esc(l.desc)}" placeholder="简介（选填）" />
                <button type="button" class="btn btn--sm btn--danger" data-link-remove="${ci}" data-link-index="${li}">删</button>
              </div>`,
            )
            .join('\n')}
        </div>
        <button type="button" class="btn btn--sm" data-link-add="${ci}">+ 添加网址</button>
      </div>`,
    )
    .join('\n');

  const content = `
    <header class="page__head page__head--row">
      <div><h1>网址导航</h1><p>前台「导航」页的分类与网址。保存后到「构建发布」上线（构建后生效）。</p></div>
      <div class="actions">
        <button type="button" class="btn" id="nav-cat-add">+ 添加分类</button>
        <button type="button" class="btn btn--primary" id="nav-save">保存</button>
      </div>
    </header>
    <div id="nav-cats">${cats || '<p class="empty">还没有分类，点「添加分类」开始。</p>'}</div>`;
  return layout({ title: '网址导航', active: 'nav-links', user, boot, content });
}

// —— 友链管理 ——
export function friendsPage({ user, boot, friends }) {
  const badge = { approved: '<span class="badge badge--pub">已通过</span>', pending: '<span class="badge badge--draft">待审核</span>', rejected: '<span class="badge badge--danger">已拒绝</span>' };
  const rows = friends.items
    .slice()
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(
      (f) => `<tr>
        <td class="cell-title">
          <a href="${esc(f.url)}" target="_blank" rel="noopener noreferrer">${esc(f.name)}</a>
          <div class="cell-sub">${esc(f.desc || '—')}</div>
        </td>
        <td><code>${esc(f.url)}</code></td>
        <td>${badge[f.status] || esc(f.status)}</td>
        <td>${f.createdAt ? new Date(f.createdAt).toLocaleDateString('zh-CN') : '—'}</td>
        <td class="cell-actions">
          ${f.status !== 'approved' ? `<button type="button" class="btn btn--sm btn--primary" data-friend-review="${esc(f.id)}" data-status="approved">通过</button>` : ''}
          ${f.status !== 'rejected' ? `<button type="button" class="btn btn--sm" data-friend-review="${esc(f.id)}" data-status="rejected">拒绝</button>` : ''}
          <button type="button" class="btn btn--sm" data-friend-edit="${esc(f.id)}">编辑</button>
          <button type="button" class="btn btn--sm btn--danger" data-friend-delete="${esc(f.id)}">删除</button>
        </td>
      </tr>`,
    )
    .join('\n');

  const pendingCount = friends.items.filter((f) => f.status === 'pending').length;

  const content = `
    <header class="page__head page__head--row">
      <div><h1>友链</h1><p>访客在前台「友链」页提交申请后进入待审核队列，通过后即刻展示。${pendingCount ? `当前有 <strong>${pendingCount}</strong> 条待审。` : ''}</p></div>
      <button type="button" class="btn btn--primary" id="friend-new">手动添加</button>
    </header>

    <section class="card">
      <h2 class="card__title">申请须知（展示在前台申请表单上方）</h2>
      <textarea class="input" id="friend-notice" rows="3">${esc(friends.notice)}</textarea>
      <div class="actions"><button type="button" class="btn" id="friend-notice-save">保存须知</button></div>
    </section>

    <div class="card">
      <table class="table">
        <thead><tr><th>站点</th><th>链接</th><th>状态</th><th>提交时间</th><th></th></tr></thead>
        <tbody>${rows || '<tr><td colspan="5" class="empty">暂无友链。</td></tr>'}</tbody>
      </table>
    </div>

    <section class="card" id="friend-editor" hidden>
      <h2 class="card__title" id="friend-editor-title">添加友链</h2>
      <input type="hidden" id="fr-id" />
      <div class="field__row">
        <label class="field" style="flex:1"><span class="field__label">站点名称 *</span><input class="input" id="fr-name" /></label>
        <label class="field" style="flex:2"><span class="field__label">站点链接 *</span><input class="input" id="fr-url" placeholder="https://…" /></label>
      </div>
      <div class="field__row">
        <label class="field" style="flex:2"><span class="field__label">头像 / Logo 链接</span><input class="input" id="fr-avatar" placeholder="https://…（选填）" /></label>
        <label class="field" style="flex:1"><span class="field__label">邮箱（选填）</span><input class="input" id="fr-email" /></label>
      </div>
      <label class="field"><span class="field__label">简介</span><input class="input" id="fr-desc" maxlength="120" /></label>
      <div class="actions">
        <button type="button" class="btn btn--primary" id="friend-save">保存友链</button>
        <button type="button" class="btn" id="friend-cancel">收起</button>
      </div>
    </section>`;
  return layout({ title: '友链', active: 'friends', user, boot, content });
}

// —— 音乐管理 ——
export function musicPage({ user, boot, tracks }) {
  const rows = tracks
    .map(
      (t) => `<tr data-track-row="${esc(t.id)}">
        <td class="cell-title">
          ${t.cover ? `<img class="track-cover" src="${esc(t.cover)}" alt="" referrerpolicy="no-referrer" />` : '<span class="track-cover track-cover--fallback">♪</span>'}
          <span>${esc(t.title)}</span>
        </td>
        <td>${esc(t.artist)}</td>
        <td>${t.source === 'local' ? '<span class="badge badge--pub">本地</span>' : '<span class="badge badge--draft">网易云</span>'}</td>
        <td>${t.enabled ? '<span class="badge badge--pub">上架</span>' : '<span class="badge badge--draft">下架</span>'}</td>
        <td class="cell-actions">
          <button type="button" class="btn btn--sm" data-track-preview="${esc(t.id)}">试听</button>
          <button type="button" class="btn btn--sm" data-track-toggle="${esc(t.id)}">${t.enabled ? '下架' : '上架'}</button>
          <button type="button" class="btn btn--sm" data-track-edit="${esc(t.id)}">编辑</button>
          <button type="button" class="btn btn--sm btn--danger" data-track-delete="${esc(t.id)}">删除</button>
        </td>
      </tr>`,
    )
    .join('\n');

  const content = `
    <header class="page__head page__head--row">
      <div><h1>音乐</h1><p>前台播放器的歌单来源：本地上传音频，或导入网易云歌曲 / 歌单。保存即生效。</p></div>
    </header>

    <section class="card">
      <h2 class="card__title">上传本地音乐</h2>
      <div class="upload-zone" id="music-upload-zone">
        <p>拖拽音频文件到此处（mp3 / flac / wav / m4a / ogg / aac，≤ 30MB），或</p>
        <label class="btn btn--primary"><input type="file" id="music-upload-input" accept="audio/*,.mp3,.flac,.wav,.m4a,.ogg,.aac" hidden />选择音频</label>
      </div>
      <div class="field__row" style="margin-top:14px">
        <label class="field" style="flex:1"><span class="field__label">曲名（留空用文件名）</span><input class="input" id="music-up-title" /></label>
        <label class="field" style="flex:1"><span class="field__label">歌手</span><input class="input" id="music-up-artist" /></label>
        <label class="field" style="flex:1"><span class="field__label">封面图链接（选填）</span><input class="input" id="music-up-cover" /></label>
      </div>
    </section>

    <section class="card">
      <h2 class="card__title">导入网易云</h2>
      <div class="field__row">
        <label class="field" style="flex:3"><span class="field__label">歌曲 / 歌单链接或 ID</span>
          <input class="input" id="music-netease-input" placeholder="如 https://music.163.com/#/song?id=… 或歌单链接 / 纯数字 ID" /></label>
        <div style="align-self:flex-end;margin-bottom:16px">
          <button type="button" class="btn btn--primary" id="music-netease-import">导入</button>
        </div>
      </div>
      <span class="field__hint">支持单曲与整个歌单（最多 500 首）。播放地址在播放时动态解析，不受外链过期影响。</span>
    </section>

    <div class="card">
      <h2 class="card__title">歌单（拖动排序可保存顺序）</h2>
      <table class="table" id="music-table">
        <thead><tr><th>曲目</th><th>歌手</th><th>来源</th><th>状态</th><th></th></tr></thead>
        <tbody>${rows || '<tr><td colspan="5" class="empty">歌单为空，上传本地音乐或导入网易云歌曲。</td></tr>'}</tbody>
      </table>
      <div class="actions">
        <button type="button" class="btn" id="music-reorder-up">上移所选</button>
        <button type="button" class="btn" id="music-reorder-down">下移所选</button>
        <button type="button" class="btn btn--primary" id="music-reorder-save">保存顺序</button>
      </div>
    </div>

    <section class="card" id="track-editor" hidden>
      <h2 class="card__title">编辑曲目</h2>
      <input type="hidden" id="tr-id" />
      <div class="field__row">
        <label class="field" style="flex:1"><span class="field__label">曲名</span><input class="input" id="tr-title" /></label>
        <label class="field" style="flex:1"><span class="field__label">歌手</span><input class="input" id="tr-artist" /></label>
        <label class="field" style="flex:1"><span class="field__label">封面图链接</span><input class="input" id="tr-cover" /></label>
      </div>
      <div class="actions">
        <button type="button" class="btn btn--primary" id="track-save">保存</button>
        <button type="button" class="btn" id="track-cancel">收起</button>
      </div>
    </section>

    <audio id="music-preview-audio" preload="none" style="width:100%;margin-top:8px" hidden></audio>`;
  return layout({ title: '音乐', active: 'music', user, boot: { ...boot, tracks }, content });
}

// —— 公告管理 ——
export function announcementsPage({ user, boot, items }) {
  const rows = items
    .slice()
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(
      (a) => `<tr>
        <td class="cell-title">${esc(a.title || '（无标题）')}
          <div class="cell-sub">${esc(a.content.slice(0, 60))}${a.content.length > 60 ? '…' : ''}</div></td>
        <td>${a.enabled ? '<span class="badge badge--pub">发布中</span>' : '<span class="badge badge--draft">已停用</span>'}</td>
        <td>${a.createdAt ? new Date(a.createdAt).toLocaleDateString('zh-CN') : '—'}</td>
        <td class="cell-actions">
          <button type="button" class="btn btn--sm" data-ann-edit="${esc(a.id)}">编辑</button>
          <button type="button" class="btn btn--sm btn--danger" data-ann-delete="${esc(a.id)}">删除</button>
        </td>
      </tr>`,
    )
    .join('\n');

  const content = `
    <header class="page__head page__head--row">
      <div><h1>公告</h1><p>前台首页顶部公告栏内容，发布即生效（无需构建）。</p></div>
      <button type="button" class="btn btn--primary" id="ann-new">新建公告</button>
    </header>

    <div class="card">
      <table class="table">
        <thead><tr><th>公告</th><th>状态</th><th>创建时间</th><th></th></tr></thead>
        <tbody>${rows || '<tr><td colspan="4" class="empty">暂无公告。</td></tr>'}</tbody>
      </table>
    </div>

    <section class="card" id="ann-editor" hidden>
      <h2 class="card__title" id="ann-editor-title">新建公告</h2>
      <input type="hidden" id="an-id" />
      <div class="field__row">
        <label class="field" style="flex:2"><span class="field__label">标题</span><input class="input" id="an-title" /></label>
        <label class="field" style="flex:1"><span class="field__label">跳转链接（选填）</span><input class="input" id="an-link" placeholder="https://…" /></label>
      </div>
      <label class="field"><span class="field__label">内容 *</span><textarea class="input" id="an-content" rows="3"></textarea></label>
      <div class="field__row">
        <label class="field" style="flex:1"><span class="field__label">生效时间（选填）</span><input class="input" type="datetime-local" id="an-start" /></label>
        <label class="field" style="flex:1"><span class="field__label">失效时间（选填）</span><input class="input" type="datetime-local" id="an-end" /></label>
        <label class="field field--inline" style="align-self:flex-end;margin-bottom:16px"><input type="checkbox" id="an-enabled" checked /><span class="field__label">启用</span></label>
      </div>
      <div class="actions">
        <button type="button" class="btn btn--primary" id="ann-save">保存公告</button>
        <button type="button" class="btn" id="ann-cancel">收起</button>
      </div>
    </section>`;
  return layout({ title: '公告', active: 'announcements', user, boot, content });
}

// —— 评论管理 ——
export function commentsPage({ user, boot, items, counts, filter = {} }) {
  const rows = items
    .map(
      (c) => `<tr>
        <td class="cell-title">
          <strong>${esc(c.nick)}</strong>${c.master ? ' <span class="badge badge--pub">博主</span>' : ''}
          ${c.status === 'hidden' ? ' <span class="badge badge--draft">已隐藏</span>' : ''}
          <div class="cell-sub"><code>${esc(c.url)}</code></div>
          <div class="cell-sub">${esc((c.commentMd || '').slice(0, 80))}${(c.commentMd || '').length > 80 ? '…' : ''}</div>
        </td>
        <td>${c.mail ? esc(c.mail) : '—'}</td>
        <td>${new Date(c.created).toLocaleString('zh-CN')}</td>
        <td>${c.like || 0}</td>
        <td class="cell-actions">
          <button type="button" class="btn btn--sm" data-comment-reply="${esc(c.id)}">回复</button>
          <button type="button" class="btn btn--sm" data-comment-status="${esc(c.id)}" data-status="${c.status === 'hidden' ? 'visible' : 'hidden'}">${c.status === 'hidden' ? '显示' : '隐藏'}</button>
          <button type="button" class="btn btn--sm btn--danger" data-comment-delete="${esc(c.id)}">删除</button>
        </td>
      </tr>`,
    )
    .join('\n');

  const content = `
    <header class="page__head page__head--row">
      <div><h1>评论</h1><p>先显后审：访客评论即时展示，可在此隐藏或删除。共 ${counts.total} 条（可见 ${counts.visible} / 隐藏 ${counts.hidden}）。</p></div>
      <div class="actions">
        <input class="input" id="comment-search" placeholder="搜索昵称 / 内容 / 页面" style="width:220px" value="${esc(filter.keyword || '')}" />
        <button type="button" class="btn${filter.status !== 'visible' && filter.status !== 'hidden' ? ' btn--primary' : ''}" data-comment-filter="all">全部</button>
        <button type="button" class="btn${filter.status === 'visible' ? ' btn--primary' : ''}" data-comment-filter="visible">可见</button>
        <button type="button" class="btn${filter.status === 'hidden' ? ' btn--primary' : ''}" data-comment-filter="hidden">已隐藏</button>
      </div>
    </header>

    <div class="card">
      <table class="table">
        <thead><tr><th>评论</th><th>邮箱</th><th>时间</th><th>赞</th><th></th></tr></thead>
        <tbody id="comment-rows">${rows || '<tr><td colspan="5" class="empty">暂无评论。</td></tr>'}</tbody>
      </table>
    </div>

    <section class="card" id="comment-reply-editor" hidden>
      <h2 class="card__title">回复评论</h2>
      <input type="hidden" id="cr-id" />
      <label class="field"><span class="field__label">回复内容（支持 Markdown）</span><textarea class="input" id="cr-text" rows="3"></textarea></label>
      <div class="actions">
        <button type="button" class="btn btn--primary" id="comment-reply-send">发布回复</button>
        <button type="button" class="btn" id="comment-reply-cancel">收起</button>
      </div>
    </section>`;
  return layout({ title: '评论', active: 'comments', user, boot: { ...boot, comments: items }, content });
}

// —— 访问统计 ——
export function statsPage({ user, boot, stats }) {
  const cards = [
    { label: '总访问量', value: stats.total },
    { label: '今日访问', value: stats.today },
    { label: '昨日访问', value: stats.yesterday },
    { label: '近 7 天', value: stats.week },
  ]
    .map((c) => `<div class="stat"><span class="stat__value">${esc(c.value)}</span><span class="stat__label">${esc(c.label)}</span></div>`)
    .join('\n');

  const maxDay = Math.max(1, ...stats.days.map((d) => d.count));
  const dayBars = stats.days
    .map(
      (d) => `<div class="bar-row">
        <span class="bar-row__label">${esc(d.date.slice(5))}</span>
        <span class="bar-row__track"><span class="bar-row__fill" style="width:${Math.round((d.count / maxDay) * 100)}%"></span></span>
        <span class="bar-row__value">${esc(d.count)}</span>
      </div>`,
    )
    .join('\n');

  const maxPath = Math.max(1, ...stats.topPaths.map((p) => p.count));
  const pathRows = stats.topPaths
    .map(
      (p) => `<tr>
        <td class="cell-title"><code>${esc(p.key)}</code><div class="cell-sub">${esc(p.title || '—')}</div></td>
        <td style="width:45%"><span class="bar-row__track"><span class="bar-row__fill" style="width:${Math.round((p.count / maxPath) * 100)}%"></span></span></td>
        <td><strong>${esc(p.count)}</strong></td>
      </tr>`,
    )
    .join('\n');

  const maxRegion = Math.max(1, ...stats.topRegions.map((r) => r.count));
  const regionRows = stats.topRegions
    .map(
      (r) => `<tr>
        <td class="cell-title">${esc(r.key)}</td>
        <td style="width:55%"><span class="bar-row__track"><span class="bar-row__fill" style="width:${Math.round((r.count / maxRegion) * 100)}%"></span></span></td>
        <td><strong>${esc(r.count)}</strong></td>
      </tr>`,
    )
    .join('\n');

  const content = `
    <header class="page__head page__head--row">
      <div><h1>访问统计</h1><p>总访问量、各页面访问排行、访客归属地排行。数据来自前台自动打点。</p></div>
      <button type="button" class="btn" onclick="location.reload()">刷新</button>
    </header>

    <div class="stats">${cards}</div>

    <section class="card">
      <h2 class="card__title">近 30 天每日访问</h2>
      ${dayBars || '<p class="empty">暂无数据。</p>'}
    </section>

    <section class="card">
      <h2 class="card__title">访问排行 · 页面</h2>
      <table class="table">
        <thead><tr><th>页面</th><th></th><th>访问</th></tr></thead>
        <tbody>${pathRows || '<tr><td colspan="3" class="empty">暂无数据。</td></tr>'}</tbody>
      </table>
    </section>

    <section class="card">
      <h2 class="card__title">访问排行 · 归属地</h2>
      <table class="table">
        <thead><tr><th>地区</th><th></th><th>访问</th></tr></thead>
        <tbody>${regionRows || '<tr><td colspan="3" class="empty">暂无数据。</td></tr>'}</tbody>
      </table>
      <span class="field__hint">归属地由 IP 解析（不保存原始 IP），解析失败记为「未知」。</span>
    </section>`;
  return layout({ title: '访问统计', active: 'stats', user, boot, content });
}
