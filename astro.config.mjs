import { defineConfig } from 'astro/config';
import rehypeImgAttrs from './src/lib/rehype-img-attrs.mjs';
import rehypeLegacyShortcodes from './src/lib/rehype-legacy-shortcodes.mjs';
import remarkLegacyShortcodes from './src/lib/remark-legacy-shortcodes.mjs';

// 构建期配置校验：SITE_URL 用于 RSS / sitemap / canonical / 页脚站点链接，
// 未配置或仍是占位符时给出醒目警告（页脚会隐藏站点链接区块，不渲染占位 URL）。
const SITE_URL = process.env.SITE_URL ?? 'https://example.com';
if (!process.env.SITE_URL || /example\.(com|org|net)|localhost/i.test(SITE_URL)) {
  console.warn(
    `[astro.config] ⚠ SITE_URL 未配置或仍是占位符（当前：${SITE_URL}）。\n` +
      '  RSS / sitemap / canonical 将使用该值，请在 .env 的 SITE_URL 填写正式域名。',
  );
}

export default defineConfig({
  site: SITE_URL,
  markdown: {
    remarkPlugins: [remarkLegacyShortcodes],
    // rehypeImgAttrs：图片加载加固（lazy/decoding/防盗链），并把独占一段的
    // 图片升级为 <figure>——Markdown 图片的 "标题" 位渲染为居中图注。
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
