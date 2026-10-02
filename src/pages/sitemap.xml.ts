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

const escapeXml = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');

const urlEntry = (path: string, lastmod?: Date) => `
  <url>
    <loc>${escapeXml(absoluteUrl(path))}</loc>
    ${lastmod ? `<lastmod>${lastmod.toISOString()}</lastmod>` : ''}
  </url>`;

export async function GET() {
  const posts = sortPosts(await getPublishedPosts());
  const categories = getCategories(posts);
  const tags = getTags(posts);

  const staticPaths = ['/', '/search/', '/archive/', '/notes/', '/projects/', '/nav/', '/friends/', '/about/'];
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
