import {
  absoluteUrl,
  getPostDescription,
  getPostUpdatedDate,
  getPostUrl,
  site,
  sortPosts,
} from '../lib/posts';
import { getPublishedPosts } from '../lib/posts';
import { escapeXml } from '../lib/escape';

export async function GET() {
  const posts = sortPosts(await getPublishedPosts());
  const latestDate = posts
    .map(getPostUpdatedDate)
    .filter(Boolean)
    .sort((a, b) => b.getTime() - a.getTime())[0];

  const items = posts
    .map((post) => {
      const url = getPostUrl(post);
      const date = getPostUpdatedDate(post);

      return `
        <item>
          <title>${escapeXml(post.data.title)}</title>
          <link>${escapeXml(url)}</link>
          <guid>${escapeXml(url)}</guid>
          ${date ? `<pubDate>${date.toUTCString()}</pubDate>` : ''}
          <description>${escapeXml(getPostDescription(post))}</description>
        </item>`;
    })
    .join('');

  const body = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>${escapeXml(site.name)}</title>
    <link>${escapeXml(absoluteUrl('/'))}</link>
    <description>${escapeXml(site.description)}</description>
    <language>zh-CN</language>
    ${latestDate ? `<lastBuildDate>${latestDate.toUTCString()}</lastBuildDate>` : ''}
    ${items}
  </channel>
</rss>`;

  return new Response(body.trim(), {
    headers: {
      'Content-Type': 'application/rss+xml; charset=utf-8',
    },
  });
}
