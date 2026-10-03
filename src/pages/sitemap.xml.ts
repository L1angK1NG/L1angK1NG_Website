import {
  absoluteUrl,
  getCategories,
  getCategoryPath,
  getPostPath,
  getPostUpdatedDate,
  getTags,
  getTagPath,
  sortPosts,
} from '../lib/posts';
import { getPublishedPosts } from '../lib/posts';
import { getProjects } from '../lib/site-content';
import { escapeXml } from '../lib/escape';

const urlEntry = (path: string, lastmod?: Date) => `
  <url>
    <loc>${escapeXml(absoluteUrl(path))}</loc>
    ${lastmod ? `<lastmod>${lastmod.toISOString()}</lastmod>` : ''}
  </url>`;

// 静态页面路由自动发现：从 src/pages 的 .astro 页面推导，新增页面无需再手动
// 同步清单。动态 [param] 路由（文章/项目/分类/标签）由下面各自的循环覆盖；
// 404 页不进 sitemap。
const pageModules = import.meta.glob('../pages/**/*.astro');
const staticPaths = Object.keys(pageModules)
  .map((file) => file.replace(/^(\.\.\/)+pages\//, '/').replace(/\.astro$/, ''))
  .filter((route) => !route.includes('[') && !route.endsWith('/404'))
  .map((route) => (route.endsWith('/index') ? `${route.slice(0, -'index'.length)}` || '/' : `${route}/`))
  .sort();

export async function GET() {
  const posts = sortPosts(await getPublishedPosts());
  const categories = getCategories(posts);
  const tags = getTags(posts);

  const paths = [
    ...staticPaths.map((path) => urlEntry(path)),
    ...posts.map((post) => urlEntry(getPostPath(post), getPostUpdatedDate(post))),
    ...getProjects().map((project) => urlEntry(`/projects/${project.slug}/`)),
    ...categories.map((category) => urlEntry(getCategoryPath(category.name))),
    ...tags.map((tag) => urlEntry(getTagPath(tag.name))),
  ];

  const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${paths.join('')}
</urlset>`;

  return new Response(body.trim(), {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
    },
  });
}
