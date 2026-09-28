import { defineConfig } from 'astro/config';
import rehypeImgAttrs from './src/lib/rehype-img-attrs.mjs';
import rehypeLegacyShortcodes from './src/lib/rehype-legacy-shortcodes.mjs';
import remarkLegacyShortcodes from './src/lib/remark-legacy-shortcodes.mjs';

export default defineConfig({
  site: process.env.SITE_URL ?? 'https://example.com',
  redirects: {
    '/projects': '/about',
  },
  markdown: {
    remarkPlugins: [remarkLegacyShortcodes],
    rehypePlugins: [rehypeLegacyShortcodes, rehypeImgAttrs],
  },
});
