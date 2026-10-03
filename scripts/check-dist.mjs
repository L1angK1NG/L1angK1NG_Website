// 构建产物体检（CI 与本地均可运行）：node scripts/check-dist.mjs
// 断言字体分片、脚本打包与若干回归点在产物中成立，防止「构建成功但产物坏掉」。
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../admin/lib/env.mjs';

const DIST = path.join(ROOT, 'dist');
const fail = (msg) => {
  console.error(`✗ ${msg}`);
  process.exitCode = 1;
};
const ok = (msg) => console.log(`✓ ${msg}`);

if (!fs.existsSync(DIST)) {
  fail('dist/ 不存在，请先运行 npm run build');
  process.exit(1);
}

// 1. 首页存在且引用站点脚本包
const indexHtml = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8');
if (indexHtml.includes('<html')) ok('index.html 已生成');
else fail('index.html 内容异常');

// 2. 字体：只引用 woff2 分片，分片文件都在，绝不再下发 25MB TTF
const cssFiles = fs
  .readdirSync(path.join(DIST, '_astro'))
  .filter((n) => n.endsWith('.css'))
  .map((n) => fs.readFileSync(path.join(DIST, '_astro', n), 'utf8'))
  .join('\n');
const fontRefs = [...new Set([...cssFiles.matchAll(/url\((\/fonts\/[^)]+)\)/g)].map((m) => m[1]))];
if (fontRefs.length > 0 && fontRefs.every((u) => u.endsWith('.woff2'))) ok(`字体引用全部为 woff2（${fontRefs.length} 个分片）`);
else fail(`字体引用异常：${fontRefs.join(', ')}`);
for (const ref of fontRefs) {
  if (!fs.existsSync(path.join(DIST, ref.replace(/^\//, '')))) fail(`字体文件缺失：${ref}`);
}
if (fs.existsSync(path.join(DIST, 'fonts', 'LXGWWenKaiMono-Medium.ttf'))) {
  fail('产物中仍包含原始 TTF（应只保留 woff2 分片）');
} else ok('产物不含原始 TTF');

// 3. 无开发期残留引用
const allHtml = [];
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full);
    else if (e.name.endsWith('.html')) allHtml.push(full);
  }
};
walk(DIST);
const viteResidue = allHtml.filter((f) => fs.readFileSync(f, 'utf8').includes('@vite/client'));
if (viteResidue.length === 0) ok('无 @vite/client 开发残留');
else fail(`发现 @vite/client 残留：${viteResidue.join(', ')}`);

// 4. 内联脚本已收敛：主题初始化内联（必须），页面脚本打包（可缓存）
if (indexHtml.includes('blog-theme')) ok('主题初始化内联片段存在');
else fail('主题初始化内联片段缺失');
if (indexHtml.includes('__blogApi')) ok('API 降级哨兵内联片段存在');
else fail('API 降级哨兵内联片段缺失');
const astroJs = fs.readdirSync(path.join(DIST, '_astro')).filter((n) => n.endsWith('.js'));
if (astroJs.length > 0) ok(`页面脚本已打包（${astroJs.length} 个 chunk）`);
else fail('未找到打包后的页面脚本');

if (process.exitCode) {
  console.error('产物体检未通过');
} else {
  console.log('产物体检全部通过');
}
