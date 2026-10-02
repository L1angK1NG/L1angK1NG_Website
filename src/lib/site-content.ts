// 构建时读取后台维护的页面内容（data/profile.json：主页首屏 + 关于页文案）。
// 文件由后台「页面内容」模块写入，「构建发布」时在此被读取进静态页面。
// 文件缺失时回退到与初始页面一致的默认文案，保证干净克隆也能正常构建。
import fs from 'node:fs';
import path from 'node:path';

export interface SocialLink {
  icon: string;
  label: string;
  href: string;
}

export interface HeroContent {
  eyebrow: string;
  title: string;
  bio: string;
  actionLabel: string;
  actionHref: string;
  socials: SocialLink[];
}

export interface AboutContent {
  lead: string;
  subs: string[];
  facts: string[];
  socials: SocialLink[];
}

export interface FooterLink {
  icon: string;
  label: string;
  // 为空时前台渲染为纯文字胶囊（如 QQ / 微信交流群）
  href: string;
}

export interface FooterContent {
  tagline: string;
  links: FooterLink[];
  // 支持 {year} / {author} 占位符，渲染时替换
  copyright: string;
  // 允许极小 HTML 子集（<a href>、<em>、<strong>），后台保存时已白名单净化
  attribution: string;
}

const DEFAULT_HERO: HeroContent = {
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
};

const DEFAULT_ABOUT: AboutContent = {
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
};

const DEFAULT_FOOTER: FooterContent = {
  tagline: 'AI · Code · Web',
  links: [
    { icon: 'bilibili', label: 'Bilibili', href: 'https://space.bilibili.com/46377861' },
    { icon: 'youtube', label: 'YouTube', href: 'https://www.youtube.com/channel/UCUuwwXFGK8Z3OBrq6PzkmUg' },
    { icon: 'rss', label: 'RSS', href: '/rss.xml' },
    { icon: 'qq', label: 'QQ 交流群', href: '' },
    { icon: 'wechat', label: '微信交流群', href: '' },
  ],
  copyright: '© {year} {author}',
  attribution:
    '由 <a href="https://astro.build" target="_blank" rel="noopener noreferrer">Astro</a> 构建',
};

interface ProfileFile {
  hero?: Partial<HeroContent>;
  about?: Partial<AboutContent>;
  footer?: Partial<FooterContent>;
}

let cached: { hero: HeroContent; about: AboutContent; footer: FooterContent } | null = null;

function readProfile(): { hero: HeroContent; about: AboutContent; footer: FooterContent } {
  if (cached) return cached;
  let saved: ProfileFile = {};
  try {
    const file = path.join(process.cwd(), 'data', 'profile.json');
    if (fs.existsSync(file)) {
      saved = JSON.parse(fs.readFileSync(file, 'utf8')) as ProfileFile;
    }
  } catch {
    // 数据损坏时用默认文案，构建不中断。
  }
  cached = {
    hero: { ...DEFAULT_HERO, ...saved.hero, socials: saved.hero?.socials?.length ? saved.hero.socials : DEFAULT_HERO.socials },
    about: { ...DEFAULT_ABOUT, ...saved.about, subs: saved.about?.subs?.length ? saved.about.subs : DEFAULT_ABOUT.subs, facts: saved.about?.facts?.length ? saved.about.facts : DEFAULT_ABOUT.facts, socials: saved.about?.socials?.length ? saved.about.socials : DEFAULT_ABOUT.socials },
    footer: {
      ...DEFAULT_FOOTER,
      ...saved.footer,
      // 逐条补齐字段并过滤空名称，避免旧数据/手改数据缺字段导致渲染异常。
      links: (saved.footer?.links?.length ? saved.footer.links : DEFAULT_FOOTER.links)
        .map((l) => ({ icon: l?.icon ?? '', label: String(l?.label ?? ''), href: String(l?.href ?? '') }))
        .filter((l) => l.label),
    },
  };
  return cached;
}

export const getHero = (): HeroContent => readProfile().hero;
export const getAbout = (): AboutContent => readProfile().about;
export const getFooter = (): FooterContent => readProfile().footer;

// —— 项目展示（data/projects.json，后台「项目」模块维护） ——
export interface ProjectLink {
  label: string;
  url: string;
}

export interface ProjectItem {
  id: string;
  slug: string;
  title: string;
  subtitle: string;
  description: string;
  cover: string;
  status: string;
  tech: string[];
  links: ProjectLink[];
  featured: boolean;
  order: number;
  content: string;
  createdAt: number;
  updatedAt: number;
}

// data/ 目录下的 JSON 读取：文件名全部为内部字面量常量，缺失/损坏时回退默认值。
function dataDir(): string {
  return path.resolve(process.cwd(), 'data');
}

function readDataJson<T>(file: string, fallback: T): T {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

export function getProjects(): ProjectItem[] {
  const saved = readDataJson<{ projects?: ProjectItem[] }>(
    path.join(dataDir(), 'projects.json'),
    { projects: [] },
  );
  return (saved.projects ?? [])
    .filter((p) => Boolean(p && p.title && p.slug))
    .map((p) => ({ ...p, tech: p.tech ?? [], links: p.links ?? [] }))
    .sort((a, b) => (b.order ?? 0) - (a.order ?? 0) || (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}

// —— 网址导航（data/nav.json，后台「网址导航」模块维护） ——
export interface NavLink {
  name: string;
  url: string;
  desc: string;
  icon: string;
}

export interface NavCategory {
  id: string;
  name: string;
  links: NavLink[];
}

export function getNavCategories(): NavCategory[] {
  const saved = readDataJson<{ categories?: NavCategory[] }>(
    path.join(dataDir(), 'nav.json'),
    { categories: [] },
  );
  return (saved.categories ?? []).filter((c) => Boolean(c && c.name && Array.isArray(c.links)));
}
