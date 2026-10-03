// 动态模块的 HTTP 路由：公开接口（前台访客用）与管理接口（后台登录后用）。
// 由 server.mjs 挂载；公开接口全部带限流，管理接口走 session + CSRF。
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { rateLimit, MUSIC_FILES_DIR } from './store.mjs';
import * as comments from './comments.mjs';
import * as siteData from './site-data.mjs';
import * as music from './music.mjs';
import * as projects from './projects.mjs';
import * as stats from './stats.mjs';

const jsonError = (res, err, fallback = '操作失败') =>
  res.status(400).json({ error: err?.message || fallback });

// ============================ 公开接口 ============================
export function publicRouter() {
  const router = express.Router();

  // —— 评论（Twikoo 协议：事件 POST /api/public/twikoo） ——
  router.post('/twikoo', async (req, res) => {
    // 按事件分桶限流：浏览（GET）宽松——每次打开文章/随笔页都算一次读，
    // 若与发送共用一个桶，刷新十来次后连看都看不了；发送与点赞各自限额防刷。
    const event = String(req.body?.event || '');
    const limitFor =
      event === 'COMMENT_GET'
        ? { key: 'comment-read', max: 60, windowMs: 5 * 60 * 1000 }
        : event === 'COMMENT_LIKE'
          ? { key: 'comment-like', max: 30, windowMs: 5 * 60 * 1000 }
          : { key: 'comment-write', max: 10, windowMs: 5 * 60 * 1000 };
    const limit = rateLimit(req, limitFor);
    if (!limit.ok) {
      return res.status(429).json({ error: `操作过于频繁，请 ${limit.retryAfter} 秒后再试。` });
    }
    const body = req.body || {};
    const ipHash = comments.mailMd5Of(req.ip || '');
    try {
      switch (body.event) {
        case 'COMMENT_GET':
          return res.json(comments.getComments({ url: body.url, page: body.page, pageSize: body.pageSize }));
        case 'COMMENT_SUBMIT':
          return res.json(
            await comments.submitComment({
              url: body.url,
              nick: body.nick,
              mail: body.mail,
              link: body.link,
              comment: body.comment,
              ua: body.ua,
              pid: body.pid,
              rid: body.rid,
              ipHash,
            }),
          );
        case 'COMMENT_LIKE':
          return res.json(await comments.likeComment({ id: body.id, ipHash }));
        default:
          return res.status(400).json({ error: '未知事件' });
      }
    } catch (err) {
      return jsonError(res, err);
    }
  });

  // —— 友链 ——
  router.get('/friends', (_req, res) => {
    const data = siteData.getFriends();
    res.json({
      notice: data.notice,
      // 前台只展示已通过审核的友链。
      items: data.items.filter((f) => f.status === 'approved'),
    });
  });

  router.post('/friends/apply', async (req, res) => {
    const limit = rateLimit(req, { key: 'friend-apply', max: 5, windowMs: 30 * 60 * 1000 });
    if (!limit.ok) {
      return res.status(429).json({ error: `提交过于频繁，请 ${limit.retryAfter} 秒后再试。` });
    }
    try {
      await siteData.applyFriend(req.body || {});
      res.json({ ok: true, message: '申请已提交，等待站长审核。通过后将展示在友链页。' });
    } catch (err) {
      return jsonError(res, err);
    }
  });

  // —— 公告 ——
  router.get('/announcements', (_req, res) => {
    res.json({ items: siteData.activeAnnouncements() });
  });

  // —— 项目 ——
  router.get('/projects', (_req, res) => {
    res.json({ items: projects.listProjects() });
  });
  router.get('/projects/:slug', (req, res) => {
    const project = projects.getProject(req.params.slug);
    if (!project) return res.status(404).json({ error: '项目不存在' });
    res.json({
      project: { ...project, contentHtml: projects.renderProjectContent(project.content) },
    });
  });

  // —— 歌单 ——
  router.get('/playlist', async (req, res) => {
    const limit = rateLimit(req, { key: 'playlist', max: 60, windowMs: 60 * 1000 });
    if (!limit.ok) return res.status(429).json({ error: '请求过于频繁' });
    try {
      res.json({ tracks: await music.publicPlaylist() });
    } catch (err) {
      jsonError(res, err, '歌单加载失败');
    }
  });

  // 网易云曲目播放地址刷新（播放失败后前端重新解析）。
  router.get('/playlist/resolve/:id', async (req, res) => {
    const limit = rateLimit(req, { key: 'resolve', max: 30, windowMs: 60 * 1000 });
    if (!limit.ok) return res.status(429).json({ error: '请求过于频繁' });
    try {
      const url = await music.resolvePlayUrl(req.params.id, { refresh: true });
      res.json({ url });
    } catch (err) {
      jsonError(res, err, '解析播放地址失败');
    }
  });

  // 歌词（LRC 文本）：经服务端转发获取，前端解析展示。
  router.get('/playlist/lyric/:id', async (req, res) => {
    const limit = rateLimit(req, { key: 'lyric', max: 60, windowMs: 60 * 1000 });
    if (!limit.ok) return res.status(429).json({ error: '请求过于频繁' });
    try {
      res.json({ lyric: await music.getLyric(req.params.id) });
    } catch (err) {
      jsonError(res, err, '歌词获取失败');
    }
  });

  // —— 访问统计打点 ——
  router.post('/view', async (req, res) => {
    const limit = rateLimit(req, { key: 'view', max: 120, windowMs: 60 * 1000 });
    if (!limit.ok) return res.status(202).json({ ok: true }); // 打点失败静默，不影响浏览
    try {
      const { path: p, title } = req.body || {};
      await stats.recordView({ path: p, title, ip: req.ip });
      res.json({ ok: true });
    } catch {
      res.json({ ok: true });
    }
  });

  // —— 站点信息聚合（前端少发请求） ——
  router.get('/site-info', (_req, res) => {
    res.json({
      profile: siteData.getProfile(),
      nav: siteData.getNavLinks(),
      announcements: siteData.activeAnnouncements(),
    });
  });

  return router;
}

// ============================ 管理接口 ============================
export function manageRouter({ requireApiAuth, requireCsrf }) {
  const router = express.Router();
  router.use(requireApiAuth);

  // —— 页面内容（主页 hero + 关于页） ——
  router.get('/profile', (_req, res) => res.json({ profile: siteData.getProfile() }));
  router.post('/profile', requireCsrf, async (req, res) => {
    try {
      res.json({ ok: true, profile: await siteData.saveProfile(req.body?.profile || {}), message: '页面内容已保存。' });
    } catch (err) {
      jsonError(res, err);
    }
  });

  // —— 网址导航 ——
  router.get('/nav', (_req, res) => res.json({ nav: siteData.getNavLinks() }));
  router.post('/nav', requireCsrf, async (req, res) => {
    try {
      res.json({ ok: true, nav: await siteData.saveNavLinks(req.body?.nav || {}), message: '导航已保存。' });
    } catch (err) {
      jsonError(res, err);
    }
  });

  // —— 友链管理 ——
  router.get('/friends', (_req, res) => res.json(siteData.getFriends()));
  router.post('/friends/notice', requireCsrf, async (req, res) => {
    try {
      res.json({ ok: true, notice: await siteData.saveFriendsNotice(req.body?.notice).notice, message: '申请须知已保存。' });
    } catch (err) {
      jsonError(res, err);
    }
  });
  router.post('/friends/save', requireCsrf, async (req, res) => {
    try {
      res.json({ ok: true, item: await siteData.saveFriend(req.body || {}), message: '友链已保存。' });
    } catch (err) {
      jsonError(res, err);
    }
  });
  router.post('/friends/review', requireCsrf, async (req, res) => {
    try {
      const item = await siteData.reviewFriend(req.body?.id, req.body?.status);
      const label = item.status === 'approved' ? '已通过，前台即刻展示' : item.status === 'rejected' ? '已拒绝' : '已重置为待审核';
      res.json({ ok: true, item, message: label });
    } catch (err) {
      jsonError(res, err);
    }
  });
  router.post('/friends/delete', requireCsrf, async (req, res) => {
    try {
      res.json({ ...(await siteData.deleteFriend(req.body?.id)), message: '友链已删除。' });
    } catch (err) {
      jsonError(res, err);
    }
  });

  // —— 项目管理 ——
  router.get('/projects', (_req, res) => res.json({ items: projects.listProjects() }));
  router.post('/projects/save', requireCsrf, (req, res) => {
    try {
      const entry = projects.saveProject(req.body || {});
      res.json({ ok: true, project: entry, message: '项目已保存。' });
    } catch (err) {
      jsonError(res, err);
    }
  });
  router.post('/projects/delete', requireCsrf, (req, res) => {
    try {
      res.json({ ...projects.deleteProject(req.body?.id), message: '项目已删除。' });
    } catch (err) {
      jsonError(res, err);
    }
  });

  // —— 音乐管理 ——
  router.get('/music', (_req, res) => res.json({ tracks: music.listTracks() }));
  router.post('/music/upload', requireCsrf, express.raw({ type: () => true, limit: '30mb' }), (req, res) => {
    try {
      const query = req.query || {};
      const track = music.addLocalTrack({
        buffer: req.body,
        originalName: String(query.filename || 'track.mp3'),
        title: String(query.title || ''),
        artist: String(query.artist || ''),
        cover: String(query.cover || ''),
      });
      res.json({ ok: true, track, message: '音频已上传并加入歌单。' });
    } catch (err) {
      jsonError(res, err);
    }
  });
  router.post('/music/import-netease', requireCsrf, async (req, res) => {
    try {
      const result = await music.importNetease(req.body?.input || '', {
        type: req.body?.type === 'playlist' || req.body?.type === 'song' ? req.body.type : undefined,
      });
      res.json({
        ok: true,
        ...result,
        message:
          result.message ||
          (result.playlist ? `已导入 ${result.tracks.length} 首歌曲。` : '已加入歌单。'),
      });
    } catch (err) {
      jsonError(res, err, '网易云导入失败');
    }
  });
  router.post('/music/update', requireCsrf, (req, res) => {
    try {
      res.json({ ok: true, track: music.updateTrack(req.body?.id, req.body || {}), message: '曲目已更新。' });
    } catch (err) {
      jsonError(res, err);
    }
  });
  router.post('/music/delete', requireCsrf, (req, res) => {
    try {
      res.json({ ...music.removeTrack(req.body?.id), message: '曲目已删除。' });
    } catch (err) {
      jsonError(res, err);
    }
  });
  router.post('/music/reorder', requireCsrf, (req, res) => {
    try {
      res.json({ ...music.reorderTracks(req.body?.ids), message: '顺序已保存。' });
    } catch (err) {
      jsonError(res, err);
    }
  });

  // —— 公告管理 ——
  router.get('/announcements', (_req, res) => res.json({ items: siteData.getAnnouncements() }));
  router.post('/announcements/save', requireCsrf, async (req, res) => {
    try {
      const entry = await siteData.saveAnnouncement(req.body || {});
      res.json({ ok: true, item: entry, message: '公告已保存。' });
    } catch (err) {
      jsonError(res, err);
    }
  });
  router.post('/announcements/delete', requireCsrf, async (req, res) => {
    try {
      res.json({ ...(await siteData.deleteAnnouncement(req.body?.id)), message: '公告已删除。' });
    } catch (err) {
      jsonError(res, err);
    }
  });

  // —— 评论管理 ——
  router.get('/comments', (req, res) => {
    res.json({
      items: comments.adminList({ status: req.query.status, keyword: req.query.keyword }),
      counts: comments.adminCount(),
    });
  });
  router.post('/comments/status', requireCsrf, async (req, res) => {
    try {
      res.json({ ...(await comments.adminSetStatus(req.body?.id, req.body?.status)), message: '评论状态已更新。' });
    } catch (err) {
      jsonError(res, err);
    }
  });
  router.post('/comments/delete', requireCsrf, async (req, res) => {
    try {
      res.json({ ...(await comments.adminRemove(req.body?.id)), message: '评论已删除。' });
    } catch (err) {
      jsonError(res, err);
    }
  });
  router.post('/comments/reply', requireCsrf, async (req, res) => {
    try {
      const result = await comments.adminReply({
        id: req.body?.id,
        comment: req.body?.comment,
        nick: req.body?.nick,
        ipHash: comments.mailMd5Of(req.ip || ''),
      });
      res.json({ ok: true, ...result, message: '回复已发布。' });
    } catch (err) {
      jsonError(res, err);
    }
  });

  // —— 访问统计 ——
  router.get('/stats', (_req, res) => res.json(stats.summary({ pathsLimit: 50, regionsLimit: 50 })));

  return router;
}

// 本地音频流式输出：支持 Range（拖动进度条需要），缓存一天。
export function musicFilesRouter() {
  const router = express.Router();
  router.get('/file/:name', (req, res) => {
    const name = path.basename(String(req.params.name || ''));
    const file = path.join(MUSIC_FILES_DIR, name);
    if (!name || name.startsWith('.') || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      return res.status(404).json({ error: '音频不存在' });
    }
    const ext = path.extname(file).toLowerCase();
    const types = {
      '.mp3': 'audio/mpeg',
      '.flac': 'audio/flac',
      '.wav': 'audio/wav',
      '.m4a': 'audio/mp4',
      '.aac': 'audio/aac',
      '.ogg': 'audio/ogg',
    };
    res.setHeader('Content-Type', types[ext] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    // express.static 不适用（目录在 data/ 下且要控制响应头），手动支持单段 Range。
    const { size } = fs.statSync(file);
    const range = req.headers.range;
    if (range) {
      const match = /bytes=(\d*)-(\d*)/.exec(range);
      const start = match && match[1] ? Number(match[1]) : 0;
      const end = match && match[2] ? Number(match[2]) : size - 1;
      if (start >= size || end >= size || start > end) {
        res.setHeader('Content-Range', `bytes */${size}`);
        return res.status(416).end();
      }
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Content-Length', end - start + 1);
      return fs.createReadStream(file, { start, end }).pipe(res);
    }
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Length', size);
    return fs.createReadStream(file).pipe(res);
  });
  return router;
}
