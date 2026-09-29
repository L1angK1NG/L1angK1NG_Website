// Admin backend: a small Express app that authenticates one admin, edits the
// Markdown content in src/content/, and triggers a static rebuild + atomic swap.
//
// Served in production behind nginx at /admin and /api (see DEPLOY.md); the
// front-end stays a pure static build.
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

// —— auth middleware ——
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

// —— pages ——
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
  // Not a content collection (e.g. /admin/media, /admin/build) — defer to the
  // specific routes registered after this generic one.
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

// —— auth API ——
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

  // Rotate the session id on login to prevent fixation, then store identity.
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

// —— content API ——
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
    // Windows forbids < > : " | ? * in filenames, so the slug may have been
    // sanitized — tell the author when the final path differs from the input.
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

// —— media ——
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

// Content-hash dedupe: identical bytes map to the same stored file, no matter
// what the incoming filename was, so articles share one physical copy instead
// of stacking timestamped duplicates. The uploads folder is small, so hashing
// the existing files per upload is cheap and leaves no index state to maintain.
function findUploadByHash(hash) {
  try {
    if (!fs.existsSync(UPLOAD_DIR)) return null;
    for (const entry of fs.readdirSync(UPLOAD_DIR, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const digest = crypto.createHash('sha256').update(fs.readFileSync(path.join(UPLOAD_DIR, entry.name))).digest('hex');
      if (digest === hash) return entry.name;
    }
  } catch {
    /* on any failure, fall through and store a new copy */
  }
  return null;
}

// Media references live inside the Markdown content itself (cover frontmatter
// and body images/links) — there is no database, so the referencing scan walks
// the content files. Both the raw and percent-encoded URL forms count.
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

// —— build ——
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

// Serve the blog's public/ so media and cover previews resolve in the editor.
// Registered after all routes so nothing here can shadow an admin/API route.
app.use(express.static(path.join(ROOT, 'public'), { maxAge: '1h' }));

// Serve the PUBLISHED site (current/) as the final fallback, so what the
// 构建并发布 button produced is viewable locally at the admin origin — the
// same bytes nginx will serve in production. npm run dev shows live source
// instead; this shows the actual build output.
app.use(express.static(path.join(ROOT, 'current')));

// Before the first publish there is no site to show at /, so land on the admin.
app.get('/', (_req, res) => res.redirect('/admin'));

// Unknown GET paths mirror the published site's 404 page when a release exists.
app.use((req, res, next) => {
  if (req.method !== 'GET' || req.path.startsWith('/api/')) return next();
  const notFound = path.join(ROOT, 'current', '404.html');
  if (fs.existsSync(notFound)) return res.status(404).sendFile(notFound);
  return next();
});

// —— error handling ——
app.use((err, req, res, _next) => {
  console.error('[admin]', err);
  if (req.path.startsWith('/api/')) return res.status(500).json({ error: '服务器内部错误' });
  return res.status(500).send('服务器内部错误');
});

app.listen(PORT, () => {
  console.log(`[admin] 博客后台已启动: http://localhost:${PORT}/admin`);
  console.log(`[admin] 内容目录: ${path.join(ROOT, 'src', 'content')}`);
});
