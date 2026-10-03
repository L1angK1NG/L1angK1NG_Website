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
import { logWarn } from './lib/log.mjs';

loadEnv();

const { newCsrfToken, requireCsrf, verifyCredentials, isLocked, recordFailure, clearFailures, MAX_LOGIN_ATTEMPTS } =
  await import('./lib/auth.mjs');
const content = await import('./lib/content.mjs');
const build = await import('./lib/build.mjs');
const backup = await import('./lib/backup.mjs');
const { renderPreview } = await import('./lib/preview.mjs');
const views = await import('./views.mjs');
const siteData = await import('./lib/site-data.mjs');
const commentsLib = await import('./lib/comments.mjs');

const app = express();
const PORT = Number(process.env.ADMIN_PORT || 4000);
const COOKIE_SECURE = process.env.COOKIE_SECURE === 'true';

// —— 会话密钥校验 ——
// SESSION_SECRET 是会话 cookie 的签名密钥：漏配或使用示例占位值时，任何人
// 都能伪造管理员会话。生产环境（NODE_ENV=production 或 COOKIE_SECURE=true）
// 直接拒绝启动；开发环境回退到已知弱密钥但打印醒目警告。
const WEAK_SECRETS = new Set(['dev-insecure-secret']);
function resolveSessionSecret() {
  const secret = (process.env.SESSION_SECRET || '').trim();
  const isProduction = process.env.NODE_ENV === 'production' || COOKIE_SECURE;
  const isWeak =
    !secret ||
    secret.length < 32 ||
    WEAK_SECRETS.has(secret) ||
    /^replace-me|^change-me|^your-|^example/i.test(secret);
  if (!isWeak) return secret;
  const reason = secret
    ? `SESSION_SECRET 过弱（长度不足 32 或仍是示例占位值）`
    : '未配置 SESSION_SECRET';
  if (isProduction) {
    console.error(
      `[admin] ${reason}。生产环境必须配置随机长字符串后才能启动，` +
        `可执行 node -e "console.log(require('crypto').randomBytes(48).toString('hex'))" 生成。已拒绝启动。`,
    );
    process.exit(1);
  }
  console.warn(`[admin] ⚠ ${reason}，已回退到开发用弱密钥——会话可被伪造，仅限本地开发。`);
  return 'dev-insecure-secret';
}

app.set('trust proxy', process.env.TRUST_PROXY || (COOKIE_SECURE ? 1 : false));
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));

// —— 统一请求入口（常量基址 + 查询传目标） ——
// 前台脚本与后台面板的动态目标一律经 /api/_ 转发：浏览器出站地址永远是
// 固定字面基址，真实路径作为 r 查询参数——服务端白名单校验后内部派发，
// 出站面收敛为单点，便于安全审计（目标仅限本服务自身的 /api 与 /admin 路由）。
const DISPATCH_RE = /^(?:\/api\/(?!_)[\w\-/.]*|\/admin(?:\/[\w-]+)*)(?:\?[^#\s]*)?$/;

app.all('/api/_', (req, res) => {
  // r 参数为 base64(encodeURIComponent(目标路径))，解码后必须通过路由白名单。
  let target = '';
  try {
    target = decodeURIComponent(Buffer.from(String(req.query.r || ''), 'base64').toString('ascii'));
  } catch {
    return res.status(400).json({ error: '非法的接口地址' });
  }
  if (!DISPATCH_RE.test(target)) {
    return res.status(400).json({ error: '非法的接口地址' });
  }
  req.url = target;
  app.handle(req, res);
});

app.use(
  '/admin-assets',
  express.static(path.join(ROOT, 'admin', 'public'), { maxAge: '1h' }),
);

// 共享的 HTML 白名单净化模块：前台评论与后台预览共用同一份源码，
// 后台以 ES module 方式加载 src/lib/sanitize.js。
app.get('/admin-assets/shared/sanitize.js', (_req, res) => {
  res.type('application/javascript').sendFile(path.join(ROOT, 'src', 'lib', 'sanitize.js'));
});

// 共享的字体分片声明（与前台 src/styles/fonts.css 同一份源码）。
app.get('/admin-assets/fonts.css', (_req, res) => {
  res.type('text/css').sendFile(path.join(ROOT, 'src', 'styles', 'fonts.css'));
});

// —— 安全响应头 ——
// 应用层自带基础安全头（nginx 配置同样提供，双保险）：即使部署者跳过 nginx
// 直连端口也不至于完全裸奔。CSP 先以 report-only 下发，观察兼容性后再收紧。
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('X-DNS-Prefetch-Control', 'off');
  if (COOKIE_SECURE) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  // 报告型 CSP：不限制现有功能，仅收集潜在违规（违规会打到浏览器控制台，
  // 不影响页面）。稳定运行后可切换为强制策略。
  res.setHeader(
    'Content-Security-Policy-Report-Only',
    "default-src 'self'; img-src 'self' data: https:; media-src 'self' https:; " +
      "script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
      "connect-src 'self' https:; frame-ancestors 'self'; base-uri 'self'; form-action 'self'",
  );
  next();
});

app.use(
  session({
    secret: resolveSessionSecret(),
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
      backupConfig: backup.getBackupConfig(),
    }),
  );
}));

// —— 数据备份配置 ——
// 仓库地址在构建发布页填写保存（存 data/backup-config.json），发布成功后的
// 自动备份会推送到这里生效的地址。GET 供页面展示，POST 供「保存地址」按钮。
app.get('/api/backup/config', requireApiAuth, (_req, res) => {
  res.json(backup.getBackupConfig());
});

app.post('/api/backup/config', requireApiAuth, requireCsrf, wrap(async (req, res) => {
  const result = backup.saveBackupRemoteUrl(req.body?.remoteUrl);
  res.status(result.ok ? 200 : 400).json(result);
}));

// —— 动态模块的后台页面 ——
// 这些路径形如 /admin/xxx，会被上面的 /admin/:collection 通用路由先行匹配，
// 但其不在 COLLECTIONS 中会 next() 到这里（与 /admin/media、/admin/build 同理）。
app.get('/admin/site-content', requirePageAuth, wrap(async (req, res) => {
  res.send(views.siteContentPage({ user: req.session.user, boot: currentBoot(req), profile: siteData.getProfile() }));
}));

app.get('/admin/projects', requirePageAuth, wrap(async (req, res) => {
  const { listProjects } = await import('./lib/projects.mjs');
  res.send(views.projectsPage({ user: req.session.user, boot: currentBoot(req), projects: listProjects() }));
}));

app.get('/admin/nav-links', requirePageAuth, wrap(async (req, res) => {
  res.send(views.navLinksPage({ user: req.session.user, boot: currentBoot(req), nav: siteData.getNavLinks() }));
}));

app.get('/admin/friends', requirePageAuth, wrap(async (req, res) => {
  res.send(views.friendsPage({ user: req.session.user, boot: currentBoot(req), friends: siteData.getFriends() }));
}));

app.get('/admin/music', requirePageAuth, wrap(async (req, res) => {
  const { listTracks } = await import('./lib/music.mjs');
  res.send(views.musicPage({ user: req.session.user, boot: currentBoot(req), tracks: listTracks() }));
}));

app.get('/admin/announcements', requirePageAuth, wrap(async (req, res) => {
  res.send(views.announcementsPage({ user: req.session.user, boot: currentBoot(req), items: siteData.getAnnouncements() }));
}));

app.get('/admin/comments', requirePageAuth, wrap(async (req, res) => {
  const status = String(req.query.status || 'all');
  const keyword = String(req.query.keyword || '');
  res.send(
    views.commentsPage({
      user: req.session.user,
      boot: currentBoot(req),
      items: commentsLib.adminList({ status, keyword }),
      counts: commentsLib.adminCount(),
      filter: { status, keyword },
    }),
  );
}));

app.get('/admin/stats', requirePageAuth, wrap(async (req, res) => {
  const { summary } = await import('./lib/stats.mjs');
  res.send(views.statsPage({ user: req.session.user, boot: currentBoot(req), stats: summary({ pathsLimit: 50, regionsLimit: 50 }) }));
}));

// —— 登录认证 API ——
app.post('/api/login', requireCsrf, wrap(async (req, res) => {
  const lockedFor = isLocked(req);
  if (lockedFor > 0) return res.status(429).json({ error: `登录尝试过于频繁，请 ${lockedFor} 秒后再试。` });

  const { username, password } = req.body || {};
  if (!(await verifyCredentials(String(username || ''), String(password || '')))) {
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

app.post('/api/logout', requireCsrf, (req, res) => {
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

app.post('/api/preview', requireApiAuth, requireCsrf, wrap(async (req, res) => {
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
  } catch (err) {
    logWarn('媒体目录读取失败', err);
    return [];
  }
}

app.get('/api/media', requireApiAuth, (_req, res) => res.json({ items: listMedia() }));

// 基于内容哈希去重：字节完全相同的文件无论上传时叫什么名字，都会映射到
// 同一个已存储文件，这样多篇文章共享一份物理副本，而不是堆叠一堆带时间戳的
// 重复文件。哈希索引在首次使用时异步构建、之后增量维护（上传/删除同步更新），
// 避免每次上传都对目录内文件做同步全量哈希阻塞事件循环。
const uploadHashMap = new Map(); // 文件名 -> sha256
let uploadHashReady = null;

function ensureUploadHashIndex() {
  if (uploadHashReady) return uploadHashReady;
  uploadHashReady = (async () => {
    try {
      if (!fs.existsSync(UPLOAD_DIR)) return;
      const entries = (await fs.promises.readdir(UPLOAD_DIR, { withFileTypes: true })).filter((e) => e.isFile());
      await Promise.all(
        entries.map(async (entry) => {
          const buf = await fs.promises.readFile(path.join(UPLOAD_DIR, entry.name));
          uploadHashMap.set(entry.name, crypto.createHash('sha256').update(buf).digest('hex'));
        }),
      );
    } catch (err) {
      // 索引构建失败时退化为不去重（每次存新副本），不影响上传
      logWarn('上传哈希索引构建失败', err);
    }
  })();
  return uploadHashReady;
}

function findUploadByHash(hash) {
  for (const [name, digest] of uploadHashMap) {
    if (digest === hash) return name;
  }
  return null;
}

// 上传内容校验（文件头 magic number + SVG 脚本剥离）实现在
// admin/lib/upload-guard.mjs，这里只做接线；规则与单元测试见该模块。
import { MAGIC_CHECKS, looksLikeSvg, sanitizeSvg } from './lib/upload-guard.mjs';

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

  // 文件头必须与扩展名一致：防止把任意内容伪装成图片扩展名上传。
  const magic = MAGIC_CHECKS[ext];
  if (magic && !magic(req.body)) {
    return res.status(400).json({ error: '文件内容与扩展名不符，已拒绝上传' });
  }
  // SVG 剥离脚本能力后再入库。
  const payload = ext === '.svg' || looksLikeSvg(req.body) ? sanitizeSvg(req.body) : req.body;

  await ensureUploadHashIndex();
  const incomingHash = crypto.createHash('sha256').update(payload).digest('hex');
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
  await fs.promises.mkdir(UPLOAD_DIR, { recursive: true });
  await fs.promises.writeFile(path.join(UPLOAD_DIR, name), payload);
  uploadHashMap.set(name, incomingHash);
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
  uploadHashMap.delete(name);
  res.json({ ok: true, message: '已删除。' });
}));

// —— 动态模块 API ——
// 公开接口供前台访客使用（评论提交、友链申请、歌单、访问打点），全部带限流；
// 管理接口在 manageRouter 内统一做登录校验，写操作再过 CSRF。
const routesLib = await import('./lib/routes.mjs');
app.use('/api/public', routesLib.publicRouter());
app.use('/api/manage', routesLib.manageRouter({ requireApiAuth, requireCsrf }));
// 本地音乐文件（data/music-files/）不随静态站构建，经 API 流式输出（支持 Range）。
app.use('/api/music', routesLib.musicFilesRouter());

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
