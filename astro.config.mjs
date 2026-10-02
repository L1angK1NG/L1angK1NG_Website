import { defineConfig } from 'astro/config';
import rehypeImgAttrs from './src/lib/rehype-img-attrs.mjs';
import rehypeLegacyShortcodes from './src/lib/rehype-legacy-shortcodes.mjs';
import remarkLegacyShortcodes from './src/lib/remark-legacy-shortcodes.mjs';

export default defineConfig({
  site: process.env.SITE_URL ?? 'https://example.com',
  markdown: {
    remarkPlugins: [remarkLegacyShortcodes],
    rehypePlugins: [rehypeLegacyShortcodes, rehypeImgAttrs],
  },
  vite: {
    server: {
      // 本地开发时把动态接口转发到后台服务（npm run admin），与生产环境
      // nginx 反代 /api 的效果一致；目标端口随 .env 的 ADMIN_PORT 走。
      proxy: {
        '/api': `http://localhost:${process.env.ADMIN_PORT || 4000}`,
      },
    },
  },
});
