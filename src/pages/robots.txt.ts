import { absoluteUrl } from '../lib/posts';

export function GET() {
  const body = [
    'User-agent: *',
    'Allow: /',
    '',
    `Sitemap: ${absoluteUrl('/sitemap.xml')}`,
  ].join('\n');

  return new Response(body, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
    },
  });
}
