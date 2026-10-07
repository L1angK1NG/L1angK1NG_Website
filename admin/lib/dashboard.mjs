// 仪表盘数据聚合：一次请求把「博客访问 / 文章数据 / 服务器监控」三块
// 全部算好返回。服务端渲染首屏与手动/自动刷新共用同一份口径，
// 前端拿到 JSON 直接填卡片，不再自己拼请求。
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './env.mjs';
import * as stats from './stats.mjs';
import * as content from './content.mjs';
import * as comments from './comments.mjs';
import * as serverMonitor from './server-monitor.mjs';
import * as build from './build.mjs';

const UPLOAD_DIR = path.join(ROOT, 'public', 'uploads');

function mediaCount() {
  try {
    if (!fs.existsSync(UPLOAD_DIR)) return 0;
    return fs.readdirSync(UPLOAD_DIR, { withFileTypes: true }).filter((e) => e.isFile()).length;
  } catch {
    return 0;
  }
}

// 分类 / 标签分布：只统计已发布的文章（草稿不参与分布，避免虚胖）。
function distribution(entries, field) {
  const counts = new Map();
  for (const e of entries) {
    if (e.data.draft) continue;
    for (const key of [].concat(e.data[field] || [])) {
      const k = String(key).trim();
      if (k) counts.set(k, (counts.get(k) || 0) + 1);
    }
  }
  return [...counts.entries()].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count);
}

// 阅读量 TOP 文章：访问排行里的 /posts/ 路径换算成文章 id 匹配标题。
// Astro 生成的 URL 全是小写，文件 id 却保留原始大小写——按小写匹配；
// 已删除但仍有历史访问的路径按统计里存的标题兜底展示。
function topReadPosts(posts, topPaths, limit = 5) {
  const byId = new Map(posts.map((p) => [p.id.toLowerCase(), p]));
  const out = [];
  for (const p of topPaths) {
    if (!p.key.startsWith('/posts/')) continue;
    const id = decodeURIComponent(p.key.replace(/^\/posts\//, '').replace(/\/$/, ''));
    const entry = byId.get(id.toLowerCase());
    out.push({
      id: entry?.id || id,
      title: entry?.data?.title || p.title || id,
      count: p.count,
      date: entry?.data?.date || '',
      exists: Boolean(entry),
    });
    if (out.length >= limit) break;
  }
  return out;
}

export async function dashboardData({ fast = false } = {}) {
  const posts = content.listEntries('posts');
  const notes = content.listEntries('notes');
  const published = posts.filter((p) => !p.data.draft);

  const s = stats.summary({ pathsLimit: 50, regionsLimit: 20 });
  const commentCounts = comments.adminCount();
  const commentTrend = comments.adminTrend();

  const status = build.lastBuildStatus();
  // fast：后台首屏渲染专用——服务器指标走缓存/瞬时值，不阻塞 HTML 输出。
  const server = await serverMonitor.snapshot({ fast });

  return {
    fetchedAt: Date.now(),
    visits: s,
    content: {
      posts: {
        total: posts.length,
        published: published.length,
        drafts: posts.length - published.length,
        trash: content.trashCount('posts'),
        categories: distribution(posts, 'categories'),
        tags: distribution(posts, 'tags'),
        latest: published.slice(0, 5).map((p) => ({ id: p.id, title: p.data.title || p.id, date: p.data.date || '' })),
        topRead: topReadPosts(posts, s.topPaths, 5),
      },
      notes: {
        total: notes.length,
        published: notes.filter((n) => !n.data.draft).length,
        drafts: notes.filter((n) => n.data.draft).length,
        trash: content.trashCount('notes'),
      },
      media: mediaCount(),
      comments: {
        ...commentCounts,
        ...commentTrend,
        // 近 7 天 / 前 7 天新增评论，供环比。
        week: commentTrend.days.slice(-7).reduce((sum, d) => sum + d.count, 0),
        prevWeek: commentTrend.days.slice(-14, -7).reduce((sum, d) => sum + d.count, 0),
      },
    },
    server,
    build: {
      status: status?.status || '尚未构建',
      finishedAt: status?.finishedAt || 0,
      release: build.currentRelease() || '',
      building: build.isBuilding(),
    },
  };
}
