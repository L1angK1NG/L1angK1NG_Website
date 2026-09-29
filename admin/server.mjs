// 后台服务：一个小型 Express 应用，负责验证唯一的管理员身份、编辑
// src/content/ 中的 Markdown 内容，并触发静态构建 + 原子切换。
//
// 生产环境中由 nginx 反向代理在 /admin 和 /api 路径下提供服务（见 DEPLOY.md）；
// 前台保持纯静态构建。
import express from 'express';
import session from 'express-session';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { loadEnv, ROOT } from './lib/env.mjs';

loadEnv();

const { newCsrfToken, safeEqual, requireCsrf, verifyCredentials, isLocked, recordFailure, clearFailures, MAX_LOGIN_ATTEMPTS } =
  await import('./lib/auth.mjs');
const content = await import('./lib/content.mjs');
const build = await import('./lib/build.mjs');
const { renderPreview } = await import('./lib/preview.mjs');
const views = await import('./views.mjs');

const app = express();
const PORT = Number(process.env.ADMIN_PORT || 4000);
const COOKIE_SECURE = process.env.COOKIE_SECURE === 'true';

app.set('trust proxy', process.env.TRUST_PROXY || (COOKIE_SECURE ? 1 : false));
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));

app.use(
  '/admin-assets',
  express.static(path.join(ROOT, 'admin', 'public'), { maxAge: '1h' }),
);

app.use(
  session({
    secret: process.env.SESSION_SECRET || 'dev-insecure-secret',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'strict',
      secure: COOKIE_SECURE,
      maxAge: 7 * 24 * 60 * 60 * 1000,
    },
  }),
);

// —— 身份验证中间件 ——
const ensureCsrf = (req) => {
  if (!req.session.csrfToken) req.session.csrfToken = newCsrfToken();
  return req.session.csrfToken;
};

function requireApiAuth(req, res, next) {
  if (!req.session?.user) return res.status(401).json({ error: '未登录或会话已过期。' });
  return next();
}

function requirePageAuth(req, res, next) {
  if (!req.session?.user) return res.redirect('/admin/login');
  return next();
}

// —— 页面路由 ——
app.get('/admin/login', (req, res) => {
  if (req.session?.user) return res.redirect('/admin');
  const csrfToken = ensureCsrf(req);
  res.send(views.loginPage({ csrfToken, error: null }));
});

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const currentBoot = (req) => ({
  user: req.session.user,
  csrfToken: req.session.csrfToken,
  currentRelease: build.currentRelease(),
});

app.get('/admin', requirePageAuth, wrap(async (req, res) => {
  const posts = content.listEntries('posts');
  const notes = content.listEntries('notes');
  const media = listMedia();
  const drafts =
    posts.filter((p) => p.data.draft).length + notes.filter((n) => n.data.draft).length;
  const status = build.lastBuildStatus();
  res.send(
    views.dashboardPage({
      user: req.session.user,
      boot: currentBoot(req),
      stats: { posts: posts.length, notes: notes.length, drafts, media: media.length },
      build: { ...status, release: build.currentRelease() },
    }),
  );
}));

app.get('/admin/:collection', requirePageAuth, wrap(async (req, res, next) => {
  const collection = req.params.collection;
  // 不是内容集合（如 /admin/media、/admin/build）——交由在这个通用路由之后
  // 注册的特定路由处理。
  if (!content.COLLECTIONS[collection]) return next();
  const entries = content.listEntries(collection);
  res.send(views.listPage({ user: req.session.user, boot: currentBoot(req), collection, entries }));
}));

app.get('/admin/:collection/new', requirePageAuth, wrap(async (req, res) => {
  const collection = req.params.collection;
  if (!content.COLLECTIONS[collection]) return res.status(404).send('Not found');
  res.send(
    views.editorPage({ user: req.session.user, boot: { ...currentBoot(req), collection, isNew: true }, collection, entry: null, isNew: true }),
  );
}));

app.get('/admin/:collection/edit', requirePageAuth, wrap(async (req, res) => {
  const collection = req.params.collection;
  if (!content.COLLECTIONS[collection]) return res.status(404).send('Not found');
  const entry = content.getEntry(collection, String(req.query.path || ''));
  if (!entry) return res.status(404).send('内容不存在');
  res.send(
    views.editorPage({ user: req.session.user, boot: { ...currentBoot(req), collection, isNew: false, originalId: entry.id }, collection, entry, isNew: false }),
  );
}));

app.get('/admin/media', requirePageAuth, wrap(async (req, res) => {
  res.send(views.mediaPage({ user: req.session.user, boot: currentBoot(req), files: listMedia() }));
}));

app.get('/admin/build', requirePageAuth, wrap(async (req, res) => {
  res.send(
    views.buildPage({
      user: req.session.user,
      boot: currentBoot(req),
      status: build.lastBuildStatus(),
      releases: build.releasesInfo(),
    }),
  );
}));

// —— 登录认证 API ——
app.post('/api/login', requireCsrf, wrap(async (req, res) => {
  const lockedFor = isLocked(req);
  if (lockedFor > 0) return res.status(429).json({ error: `登录尝试过于频繁，请 ${lockedFor} 秒后再试。` });

  const { username, password } = req.body || {};
  if (!verifyCredentials(String(username || ''), String(password || ''))) {
    const used = recordFailure(req);
    const remaining = Math.max(0, MAX_LOGIN_ATTEMPTS - used);
    const hint = remaining > 0
      ? `（还可尝试 ${remaining} 次）`
      : '（已触发保护锁定，请 15 分钟后再试或重启后台服务）';
    return res.status(401).json({ error: `用户名或密码错误。${hint}` });
  }
  clearFailures(req);

  // 登录时轮换 session id 以防止会话固定攻击，然后存储身份信息。
  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ error: '登录失败，请重试。' });
    req.session.user = process.env.ADMIN_USER || 'admin';
    req.session.csrfToken = newCsrfToken();
    req.session.save((saveErr) => {
      if (saveErr) return res.status(500).json({ error: '登录失败，请重试。' });
      return res.json({ ok: true, user: req.session.user, csrfToken: req.session.csrfToken });
    });
  });
}));

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('connect.sid');
    res.json({ ok: true });
  });
});

// —— 内容 API ——
app.get('/api/list/:collection', requireApiAuth, wrap(async (req, res) => {
  const collection = req.params.collection;
  if (!content.COLLECTIONS[collection]) return res.status(400).json({ error: '未知的内容类型' });
  res.json({ items: content.listEntries(collection) });
}));

app.get('/api/entry/:collection', requireApiAuth, wrap(async (req, res) => {
  const collection = req.params.collection;
  const entry = content.getEntry(collection, String(req.query.path || ''));
  if (!entry) return res.status(404).json({ error: '内容不存在' });
  res.json({ entry });
}));

app.post('/api/save/:collection', requireApiAuth, requireCsrf, wrap(async (req, res) => {
  const collection = req.params.collection;
  if (!content.COLLECTIONS[collection]) return res.status(400).json({ error: '未知的内容类型' });
  const { id, originalId, fields, body } = req.body || {};
  let targetId = String(id || '').trim();
  if (!targetId) {
    targetId = content.suggestId(collection, fields?.title, fields?.date);
  }
  try {
    const saved = content.saveEntry(collection, targetId, fields || {}, body || '', originalId || null);
    // Windows 文件名不允许 < > : " | ? * 这些字符，因此 slug 可能已被自动
    // 清洗——当最终路径与输入不一致时，要把这一点告知作者。
    const adjusted = saved.id !== targetId ? `，路径已自动调整为 ${saved.id}` : '';
    res.json({ ok: true, id: saved.id, message: `已保存到文件${adjusted}。发布需到「构建发布」。` });
  } catch (err) {
    res.status(400).json({ error: err.message || '保存失败' });
  }
}));

app.post('/api/delete/:collection', requireApiAuth, requireCsrf, wrap(async (req, res) => {
  const collection = req.params.collection;
  try {
    content.deleteEntry(collection, String(req.body?.id || ''));
    res.json({ ok: true, message: '已删除。' });
  } catch (err) {
    res.status(400).json({ error: err.message || '删除失败' });
  }
}));

app.post('/api/preview', requireApiAuth, wrap(async (req, res) => {
  res.json({ html: renderPreview(req.body?.markdown || '') });
}));

// —— 媒体 ——
const UPLOAD_DIR = path.join(ROOT, 'public', 'uploads');
function listMedia() {
  try {
    if (!fs.existsSync(UPLOAD_DIR)) return [];
    return fs
      .readdirSync(UPLOAD_DIR, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => ({ name: e.name, url: `/uploads/${e.name}` }))
      .sort((a, b) => b.name.localeCompare(a.name));
  } catch {
    return [];
  }
}

app.get('/api/media', requireApiAuth, (_req, res) => res.json({ items: listMedia() }));

// 基于内容哈希去重：字节完全相同的文件无论上传时叫什么名字，都会映射到
// 同一个已存储文件，这样多篇文章共享一份物理副本，而不是堆叠一堆带时间戳的
// 重复文件。uploads 文件夹很小，因此每次上传时对现有文件逐一计算哈希开销
// 很低，也无需维护任何索引状态。
function findUploadByHash(hash) {
  try {
    if (!fs.existsSync(UPLOAD_DIR)) return null;
    for (const entry of fs.readdirSync(UPLOAD_DIR, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const digest = crypto.createHash('sha256').update(fs.readFileSync(path.join(UPLOAD_DIR, entry.name))).digest('hex');
      if (digest === hash) return entry.name;
    }
  } catch {
    /* 出现任何异常时直接跳过，存储一份新副本 */
  }
  return null;
}

// 媒体引用就存在于 Markdown 内容本身（封面 frontmatter 以及正文中的图片/链接）
// —— 没有数据库，因此引用扫描会遍历内容文件。原始 URL 和百分号编码后的 URL
// 两种形式都计入引用。
function findUploadReferences(name) {
  const needle = `/uploads/${name}`;
  const needleEncoded = `/uploads/${encodeURIComponent(name)}`;
  const refs = [];
  for (const collectionName of Object.keys(content.COLLECTIONS)) {
    for (const entry of content.listEntries(collectionName)) {
      const haystack = `${entry.data?.cover ?? ''}\n${entry.body ?? ''}`;
      if (haystack.includes(needle) || haystack.includes(needleEncoded)) {
        refs.push(`${collectionName}/${entry.id}`);
      }
    }
  }
  return refs;
}

const SAFE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.avif', '.ico']);
app.post('/api/upload', requireApiAuth, requireCsrf, express.raw({ type: () => true, limit: '15mb' }), wrap(async (req, res) => {
  const original = String(req.query.filename || 'image.png');
  const ext = path.extname(original).toLowerCase();
  if (!SAFE_EXT.has(ext)) return res.status(400).json({ error: '不支持的文件类型' });
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) return res.status(400).json({ error: '文件为空' });

  const incomingHash = crypto.createHash('sha256').update(req.body).digest('hex');
  const existingName = findUploadByHash(incomingHash);
  if (existingName) {
    return res.json({
      ok: true,
      url: `/uploads/${existingName}`,
      name: existingName,
      duplicate: true,
      message: '文件内容与已有文件相同，已复用现有文件。',
    });
  }

  const base = path
    .basename(original, ext)
    .replace(/[^\w一-龥-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'image';
  const name = `${Date.now()}-${base}${ext}`;
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  fs.writeFileSync(path.join(UPLOAD_DIR, name), req.body);
  res.json({ ok: true, url: `/uploads/${name}`, name, duplicate: false });
}));

app.post('/api/media/delete', requireApiAuth, requireCsrf, wrap(async (req, res) => {
  const name = path.basename(String(req.body?.name || ''));
  const filePath = path.join(UPLOAD_DIR, name);
  if (!name || name.startsWith('.') || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return res.status(404).json({ error: '文件不存在' });
  }
  const references = findUploadReferences(name);
  if (references.length > 0) {
    return res.status(409).json({
      error: `该文件仍被 ${references.length} 篇内容引用（${references.join('、')}），请先移除引用再删除。`,
      references,
    });
  }
  fs.unlinkSync(filePath);
  res.json({ ok: true, message: '已删除。' });
}));

// —— 构建 ——
app.post('/api/build', requireApiAuth, requireCsrf, wrap(async (_req, res) => {
  if (build.isBuilding()) return res.status(409).json({ error: '已有构建正在进行中。' });
  const result = await build.buildAndPublish();
  res.status(result.ok ? 200 : 500).json(result);
}));

app.get('/api/build/status', requireApiAuth, (_req, res) => {
  res.json({ status: build.lastBuildStatus(), building: build.isBuilding(), releases: build.releasesInfo(), current: build.currentRelease() });
});

app.post('/api/build/rollback', requireApiAuth, requireCsrf, wrap(async (_req, res) => {
  try {
    const target = build.rollback();
    res.json({ ok: true, release: target, message: `已回滚到 ${target}` });
  } catch (err) {
    res.status(400).json({ error: err.message || '回滚失败' });
  }
}));

// 提供博客的 public/ 目录，让编辑器中的媒体和封面预览能正常解析。
// 注册在所有路由之后，确保这里的静态服务不会遮蔽任何 admin/API 路由。
app.use(express.static(path.join(ROOT, 'public'), { maxAge: '1h' }));

// 将已发布的站点（current/）作为最终回退提供服务，这样「构建并发布」按钮
// 产出的内容就能在本地后台源上直接查看——与生产环境中 nginx 提供的字节完全
// 相同。npm run dev 展示的是实时源码；这里展示的则是实际的构建产物。
app.use(express.static(path.join(ROOT, 'current')));

// 首次发布之前，/ 路径下没有站点可展示，因此直接落到后台页面。
app.get('/', (_req, res) => res.redirect('/admin'));

// 存在发布版本时，未知的 GET 路径沿用已发布站点的 404 页面。
app.use((req, res, next) => {
  if (req.method !== 'GET' || req.path.startsWith('/api/')) return next();
  const notFound = path.join(ROOT, 'current', '404.html');
  if (fs.existsSync(notFound)) return res.status(404).sendFile(notFound);
  return next();
});

// —— 错误处理 ——
app.use((err, req, res, _next) => {
  console.error('[admin]', err);
  if (req.path.startsWith('/api/')) return res.status(500).json({ error: '服务器内部错误' });
  return res.status(500).send('服务器内部错误');
});

app.listen(PORT, () => {
  console.log(`[admin] 博客后台已启动: http://localhost:${PORT}/admin`);
  console.log(`[admin] 内容目录: ${path.join(ROOT, 'src', 'content')}`);
});
