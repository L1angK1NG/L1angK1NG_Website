// 站点展示类数据的存取：页面内容（主页 hero + 关于页）、网址导航、
// 友链（含访客申请与审核）、公告栏。数据落在 data/ 下的 JSON 文件，
// 与前台构建共用同一份数据源（前台构建时通过 src/lib/site-data.ts 读取）。
import { readJSON, writeJSONAsync, withFileLock, newId } from './store.mjs';

// —— 页面内容（主页 hero + 关于页，统一编辑） ——
const PROFILE_FILE = 'profile.json';

export const DEFAULT_PROFILE = {
  hero: {
    eyebrow: 'AI · Code · Web',
    title: '你好，我是L1angK1NG',
    bio: '这里记录 AI 工具、代码实践、网站搭建和一些技术观察。文章偏实用，也保留个人判断。',
    actionLabel: '浏览文章',
    actionHref: '/archive/',
    socials: [
      { icon: 'bilibili', label: 'Bilibili', href: 'https://space.bilibili.com/46377861' },
      { icon: 'douyin', label: '抖音', href: 'https://www.douyin.com/user/self' },
      { icon: 'youtube', label: 'YouTube', href: 'https://www.youtube.com/channel/UCUuwwXFGK8Z3OBrq6PzkmUg' },
      { icon: 'x-platform', label: 'X', href: 'https://x.com/shenfanlaogou' },
      { icon: 'rss', label: 'RSS', href: '/rss.xml' },
    ],
  },
  about: {
    lead: '比起追新，我更在意一个工具<em>到底好不好用</em>。',
    subs: [
      '这里大多是亲手用过、踩过坑之后的实践笔记 —— 偏实用，也保留个人判断。',
      '而这个网站本身，从设计到每一行代码，<em>全部由 AI 开发完成</em> —— 也算是对「到底好不好用」的一份现场答卷。',
    ],
    facts: ['全站由 AI 开发'],
    socials: [
      { icon: 'bilibili', label: 'Bilibili', href: 'https://space.bilibili.com/46377861' },
      { icon: 'youtube', label: 'YouTube', href: 'https://www.youtube.com/channel/UCUuwwXFGK8Z3OBrq6PzkmUg' },
      { icon: 'x-platform', label: 'X', href: 'https://x.com/shenfanlaogou' },
      { icon: 'rss', label: 'RSS', href: '/rss.xml' },
    ],
  },
  footer: {
    tagline: 'AI · Code · Web',
    // href 留空的链接在前台渲染为纯文字胶囊（如 QQ / 微信交流群）
    links: [
      { icon: 'bilibili', label: 'Bilibili', href: 'https://space.bilibili.com/46377861' },
      { icon: 'youtube', label: 'YouTube', href: 'https://www.youtube.com/channel/UCUuwwXFGK8Z3OBrq6PzkmUg' },
      { icon: 'rss', label: 'RSS', href: '/rss.xml' },
      { icon: 'qq', label: 'QQ 交流群', href: '' },
      { icon: 'wechat', label: '微信交流群', href: '' },
    ],
    // {year} / {author} 在前台渲染时替换为当前年份与站点作者
    copyright: '© {year} {author}',
    attribution: '由 <a href="https://astro.build" target="_blank" rel="noopener noreferrer">Astro</a> 构建',
  },
};

const cleanSocials = (list) =>
  (Array.isArray(list) ? list : [])
    .map((s) => ({
      icon: String(s?.icon || '').trim().slice(0, 32),
      label: String(s?.label || '').trim().slice(0, 32),
      href: String(s?.href || '').trim().slice(0, 300),
    }))
    .filter((s) => s.label && s.href);

// 页脚链接：只需名称；链接可空（前台渲染为纯文字胶囊），图标可空。
const cleanFooterLinks = (list) =>
  (Array.isArray(list) ? list : [])
    .map((s) => ({
      icon: String(s?.icon || '').trim().slice(0, 32),
      label: String(s?.label || '').trim().slice(0, 32),
      href: String(s?.href || '').trim().slice(0, 300),
    }))
    .filter((s) => s.label && !/^javascript:/i.test(s.href));

const escAttr = (v) =>
  String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

// 归属文字允许的极小 HTML 子集：<a href>（http(s) / 相对路径 / 锚点 / mailto）、
// <em>、<strong>，其余标签一律转义为纯文本，避免保存的标记被浏览器当真执行。
const sanitizeAttribution = (html) =>
  String(html ?? '').replace(
    /<\s*(\/?)\s*([a-zA-Z][a-zA-Z0-9]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g,
    (m, close, rawTag, attrs) => {
      const tag = rawTag.toLowerCase();
      if (!close && (tag === 'em' || tag === 'strong')) return `<${tag}>`;
      if (close && (tag === 'em' || tag === 'strong' || tag === 'a')) return `</${tag}>`;
      if (!close && tag === 'a') {
        const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(attrs);
        const url = (href?.[1] ?? href?.[2] ?? href?.[3] ?? '').trim();
        if (/^(https?:\/\/|\/|#|mailto:)/i.test(url)) {
          const rel = /^https?:\/\//i.test(url) ? ' target="_blank" rel="noopener noreferrer"' : '';
          return `<a href="${escAttr(url)}"${rel}>`;
        }
      }
      return escAttr(m);
    },
  );

export function getProfile() {
  const saved = readJSON(PROFILE_FILE, {});
  return {
    hero: {
      ...DEFAULT_PROFILE.hero,
      ...(saved.hero || {}),
      socials: cleanSocials(saved.hero?.socials ?? DEFAULT_PROFILE.hero.socials),
    },
    about: {
      ...DEFAULT_PROFILE.about,
      ...(saved.about || {}),
      subs: (saved.about?.subs ?? DEFAULT_PROFILE.about.subs).map((v) => String(v).slice(0, 2000)),
      facts: (saved.about?.facts ?? DEFAULT_PROFILE.about.facts).map((v) => String(v).slice(0, 200)),
      socials: cleanSocials(saved.about?.socials ?? DEFAULT_PROFILE.about.socials),
    },
    footer: {
      tagline: String(saved.footer?.tagline ?? DEFAULT_PROFILE.footer.tagline).trim().slice(0, 60),
      links: cleanFooterLinks(saved.footer?.links ?? DEFAULT_PROFILE.footer.links),
      copyright: String(saved.footer?.copyright ?? DEFAULT_PROFILE.footer.copyright).trim().slice(0, 200),
      attribution: String(saved.footer?.attribution ?? DEFAULT_PROFILE.footer.attribution).slice(0, 400),
    },
  };
}

export function saveProfile(input) {
  return withFileLock(PROFILE_FILE, async () => {
  const current = getProfile();
  const out = {
    hero: {
      eyebrow: String(input?.hero?.eyebrow ?? current.hero.eyebrow).trim().slice(0, 60),
      title: String(input?.hero?.title ?? current.hero.title).trim().slice(0, 80),
      bio: String(input?.hero?.bio ?? current.hero.bio).trim().slice(0, 600),
      actionLabel: String(input?.hero?.actionLabel ?? current.hero.actionLabel).trim().slice(0, 20),
      actionHref: String(input?.hero?.actionHref ?? current.hero.actionHref).trim().slice(0, 300),
      socials: cleanSocials(input?.hero?.socials ?? current.hero.socials),
    },
    about: {
      lead: String(input?.about?.lead ?? current.about.lead).trim().slice(0, 300),
      subs: (input?.about?.subs ?? current.about.subs).map((v) => String(v).trim().slice(0, 2000)).filter(Boolean),
      facts: (input?.about?.facts ?? current.about.facts).map((v) => String(v).trim().slice(0, 200)).filter(Boolean),
      socials: cleanSocials(input?.about?.socials ?? current.about.socials),
    },
    footer: {
      tagline: String(input?.footer?.tagline ?? current.footer.tagline).trim().slice(0, 60),
      links: cleanFooterLinks(input?.footer?.links ?? current.footer.links),
      copyright: String(input?.footer?.copyright ?? current.footer.copyright).trim().slice(0, 200),
      attribution: sanitizeAttribution(String(input?.footer?.attribution ?? current.footer.attribution).trim().slice(0, 400)),
    },
  };
  await writeJSONAsync(PROFILE_FILE, out);
  return out;
  });
}

// —— 网址导航 ——
const NAV_FILE = 'nav.json';

export function getNavLinks() {
  const saved = readJSON(NAV_FILE, { categories: [] });
  const categories = Array.isArray(saved.categories) ? saved.categories : [];
  return {
    categories: categories.map((cat, ci) => ({
      id: String(cat?.id || `cat-${ci}`).slice(0, 40),
      name: String(cat?.name || '').trim().slice(0, 40),
      links: (Array.isArray(cat?.links) ? cat.links : [])
        .map((l) => ({
          name: String(l?.name || '').trim().slice(0, 60),
          url: String(l?.url || '').trim().slice(0, 300),
          desc: String(l?.desc || '').trim().slice(0, 120),
          icon: String(l?.icon || '').trim().slice(0, 300),
        }))
        .filter((l) => l.name && l.url),
    })),
  };
}

export function saveNavLinks(input) {
  return withFileLock(NAV_FILE, async () => {
  const categories = (Array.isArray(input?.categories) ? input.categories : [])
    .map((cat, ci) => ({
      id: String(cat?.id || '').trim().slice(0, 40) || `cat-${ci + 1}`,
      name: String(cat?.name || '').trim().slice(0, 40),
      links: (Array.isArray(cat?.links) ? cat.links : [])
        .map((l) => ({
          name: String(l?.name || '').trim().slice(0, 60),
          url: String(l?.url || '').trim().slice(0, 300),
          desc: String(l?.desc || '').trim().slice(0, 120),
          icon: String(l?.icon || '').trim().slice(0, 300),
        }))
        .filter((l) => l.name && l.url),
    }))
    .filter((cat) => cat.name && cat.links.length > 0);
  await writeJSONAsync(NAV_FILE, { categories });
  return { categories };
  });
}

// —— 友链（展示 + 访客申请 + 后台审核） ——
const FRIENDS_FILE = 'friends.json';

const DEFAULT_FRIENDS = {
  notice:
    '欢迎交换友链：请先在贵站添加本站链接，再提交申请。头像建议使用 https 直链，通过审核后即可展示。',
  items: [],
};

export function getFriends() {
  const saved = readJSON(FRIENDS_FILE, DEFAULT_FRIENDS);
  return {
    notice: String(saved.notice ?? DEFAULT_FRIENDS.notice).slice(0, 1000),
    items: (Array.isArray(saved.items) ? saved.items : []).map((f) => ({
      id: String(f?.id || ''),
      name: String(f?.name || '').trim().slice(0, 40),
      url: String(f?.url || '').trim().slice(0, 300),
      avatar: String(f?.avatar || '').trim().slice(0, 300),
      desc: String(f?.desc || '').trim().slice(0, 120),
      email: String(f?.email || '').trim().slice(0, 100),
      status: ['approved', 'pending', 'rejected'].includes(f?.status) ? f.status : 'pending',
      createdAt: Number(f?.createdAt) || 0,
      reviewedAt: Number(f?.reviewedAt) || 0,
    })),
  };
}

export function saveFriendsNotice(notice) {
  return withFileLock(FRIENDS_FILE, async () => {
    const data = getFriends();
    data.notice = String(notice ?? '').trim().slice(0, 1000);
    await writeJSONAsync(FRIENDS_FILE, data);
    return data;
  });
}

// 访客提交友链申请：一律先进 pending 队列，等待后台审核。
export function applyFriend({ name, url, avatar, desc, email }) {
  return withFileLock(FRIENDS_FILE, async () => {
  const data = getFriends();
  const item = {
    id: newId(),
    name: String(name || '').trim().slice(0, 40),
    url: String(url || '').trim().slice(0, 300),
    avatar: String(avatar || '').trim().slice(0, 300),
    desc: String(desc || '').trim().slice(0, 120),
    email: String(email || '').trim().slice(0, 100),
    status: 'pending',
    createdAt: Date.now(),
    reviewedAt: 0,
  };
  if (!item.name) throw new Error('请填写站点名称');
  if (!/^https?:\/\//i.test(item.url)) throw new Error('站点链接需以 http(s):// 开头');
  if (item.avatar && !/^https?:\/\//i.test(item.avatar)) throw new Error('头像链接需以 http(s):// 开头');
  // 同一链接只保留一条申请，重复提交视为更新。
  const dup = data.items.find((f) => f.url.toLowerCase() === item.url.toLowerCase());
  if (dup) {
    Object.assign(dup, { ...item, id: dup.id, createdAt: dup.createdAt || item.createdAt, status: 'pending' });
  } else {
    data.items.push(item);
  }
  await writeJSONAsync(FRIENDS_FILE, data);
  return dup || item;
  });
}

export function saveFriend(input) {
  return withFileLock(FRIENDS_FILE, async () => {
  const data = getFriends();
  const id = String(input?.id || '');
  const item = data.items.find((f) => f.id === id);
  if (!item) throw new Error('友链不存在');
  item.name = String(input?.name ?? item.name).trim().slice(0, 40) || item.name;
  item.url = String(input?.url ?? item.url).trim().slice(0, 300) || item.url;
  if (!/^https?:\/\//i.test(item.url)) throw new Error('站点链接需以 http(s):// 开头');
  item.avatar = String(input?.avatar ?? item.avatar).trim().slice(0, 300);
  item.desc = String(input?.desc ?? item.desc).trim().slice(0, 120);
  item.email = String(input?.email ?? item.email).trim().slice(0, 100);
  await writeJSONAsync(FRIENDS_FILE, data);
  return item;
  });
}

// 审核：approved 即刻出现在前台友链页，rejected 仅后台可见。
export function reviewFriend(id, status) {
  return withFileLock(FRIENDS_FILE, async () => {
    if (!['approved', 'pending', 'rejected'].includes(status)) throw new Error('审核状态无效');
    const data = getFriends();
    const item = data.items.find((f) => f.id === String(id));
    if (!item) throw new Error('友链不存在');
    item.status = status;
    item.reviewedAt = Date.now();
    await writeJSONAsync(FRIENDS_FILE, data);
    return item;
  });
}

export function deleteFriend(id) {
  return withFileLock(FRIENDS_FILE, async () => {
    const data = getFriends();
    const next = data.items.filter((f) => f.id !== String(id));
    if (next.length === data.items.length) throw new Error('友链不存在');
    data.items = next;
    await writeJSONAsync(FRIENDS_FILE, data);
    return { ok: true };
  });
}

// —— 公告栏 ——
const ANNOUNCE_FILE = 'announcements.json';

export function getAnnouncements() {
  const list = readJSON(ANNOUNCE_FILE, []);
  return (Array.isArray(list) ? list : []).map((a) => ({
    id: String(a?.id || ''),
    title: String(a?.title || '').trim().slice(0, 100),
    content: String(a?.content || '').trim().slice(0, 2000),
    link: String(a?.link || '').trim().slice(0, 300),
    enabled: a?.enabled !== false,
    startAt: Number(a?.startAt) || 0,
    endAt: Number(a?.endAt) || 0,
    createdAt: Number(a?.createdAt) || 0,
  }));
}

export function saveAnnouncement(input) {
  return withFileLock(ANNOUNCE_FILE, async () => {
  const list = getAnnouncements();
  const id = String(input?.id || '');
  const entry = {
    id: id || newId(),
    title: String(input?.title || '').trim().slice(0, 100),
    content: String(input?.content || '').trim().slice(0, 2000),
    link: String(input?.link || '').trim().slice(0, 300),
    enabled: input?.enabled !== false,
    startAt: Number(input?.startAt) || 0,
    endAt: Number(input?.endAt) || 0,
    createdAt: Number(input?.createdAt) || Date.now(),
  };
  if (!entry.title && !entry.content) throw new Error('公告标题或内容至少填一项');
  const idx = list.findIndex((a) => a.id === entry.id);
  if (idx >= 0) list[idx] = entry;
  else list.push(entry);
  await writeJSONAsync(ANNOUNCE_FILE, list);
  return entry;
  });
}

export function deleteAnnouncement(id) {
  return withFileLock(ANNOUNCE_FILE, async () => {
    const list = getAnnouncements();
    const next = list.filter((a) => a.id !== String(id));
    if (next.length === list.length) throw new Error('公告不存在');
    await writeJSONAsync(ANNOUNCE_FILE, next);
    return { ok: true };
  });
}

// 前台可见的公告：已启用且在有效期内。
export function activeAnnouncements() {
  const now = Date.now();
  return getAnnouncements()
    .filter((a) => a.enabled && (!a.startAt || a.startAt <= now) && (!a.endAt || a.endAt >= now))
    .sort((a, b) => b.createdAt - a.createdAt);
}
