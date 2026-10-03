// 字体子集化脚本（构建期资源优化，一次性生成产物后入库）：
//   node scripts/subset-font.mjs
// 把 public/fonts/LXGWWenKaiMono-Medium.ttf（约 25MB）按字符集拆成 3 个
// woff2 分片（拉丁 / 常用汉字 / 生僻汉字），配合 global.css 的 unicode-range
// 按需加载。字符集 = GB2312 全集（6763 汉字 + 符号）∪ 站内实际出现的字符，
// 覆盖正文与界面文案；超出子集的字符由 CSS 回退到系统字体。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../admin/lib/env.mjs';

// 源 TTF 不随仓库分发（25MB 原始素材已被 woff2 分片取代，gitignore 忽略）：
// 重新生成时把 LXGWWenKaiMono-Medium.ttf 放到项目根目录或 public/fonts/ 下。
const OUT_DIR = path.join(ROOT, 'public', 'fonts');
const SRC_FONT = [
  path.join(ROOT, 'LXGWWenKaiMono-Medium.ttf'),
  path.join(OUT_DIR, 'LXGWWenKaiMono-Medium.ttf'),
].find((p) => fs.existsSync(p));

if (!SRC_FONT) {
  console.error(
    '未找到源字体 LXGWWenKaiMono-Medium.ttf。\n' +
      '请把完整 TTF 放到项目根目录（或 public/fonts/）后重新运行：npm run subset:font',
  );
  process.exit(1);
}

// —— 字符集构建 ——
// 1. 拉丁分片：ASCII + 常用标点 + 箭头/数学等常用符号
const latinRanges = [
  [0x0020, 0x007e], // 基本拉丁
  [0x00a0, 0x00ff], // 拉丁补充（含常用西欧字符）
  [0x2000, 0x206f], // 常用标点
  [0x2100, 0x214f], // 字母式符号（℃ 等）
  [0x2190, 0x21ff], // 箭头
  [0x2200, 0x22ff], // 数学运算符
  [0x2460, 0x24ff], // 带圈数字/序号
  [0x25a0, 0x25ff], // 几何图形
];

// 2. GB2312 汉字分区：双字节 0xB0-0xD7 为一级常用字，0xD8-0xF7 为二级
const gb2312L1 = new Set();
const gb2312L2 = new Set();
const gb2312Symbols = new Set(); // GB2312 中的标点/符号/日文假名等非汉字区
for (let hi = 0xa1; hi <= 0xf7; hi += 1) {
  for (let lo = 0xa1; lo <= 0xfe; lo += 1) {
    const buf = Buffer.from([hi, lo]);
    let ch;
    try {
      ch = new TextDecoder('gb18030').decode(buf);
    } catch {
      continue;
    }
    if (!ch || ch.length !== 1) continue;
    const cp = ch.codePointAt(0);
    const isCjk = cp >= 0x4e00 && cp <= 0x9fff;
    if (isCjk) {
      if (hi <= 0xd7) gb2312L1.add(ch);
      else gb2312L2.add(ch);
    } else {
      gb2312Symbols.add(ch);
    }
  }
}

// 3. 站内实际出现的字符：扫描源码、数据与文章，保证现有内容零缺字
const usedChars = new Set();
const scanExt = new Set(['.md', '.mdx', '.astro', '.ts', '.js', '.mjs', '.json', '.css', '.html']);
const scanDirs = ['src', 'data', 'admin'];
const scan = (dir) => {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) scan(full);
    else if (entry.isFile() && scanExt.has(path.extname(entry.name))) {
      try {
        for (const ch of fs.readFileSync(full, 'utf8')) usedChars.add(ch);
      } catch {
        /* 二进制误入时忽略 */
      }
    }
  }
};
for (const dir of scanDirs) scan(path.join(ROOT, dir));

const inLatin = (ch) => latinRanges.some(([a, b]) => cp(ch) >= a && cp(ch) <= b);
function cp(ch) {
  return ch.codePointAt(0);
}

// 分片归属：拉丁 → latin；GB2312 一级汉字 → cjk-common；其余（二级字、
// 符号、站内出现的任何字符）→ cjk-ext。
const shardChars = {
  'wenkai-latin': new Set(),
  'wenkai-cjk-common': new Set(),
  'wenkai-cjk-ext': new Set(),
};
const put = (ch) => {
  if (!ch || ch === '\n' || ch === '\r' || ch === '\t') return;
  if (inLatin(ch)) shardChars['wenkai-latin'].add(ch);
  else if (gb2312L1.has(ch)) shardChars['wenkai-cjk-common'].add(ch);
  else shardChars['wenkai-cjk-ext'].add(ch);
};
for (const [a, b] of latinRanges) for (const ch of range(a, b)) shardChars['wenkai-latin'].add(ch);
for (const ch of gb2312L1) shardChars['wenkai-cjk-common'].add(ch);
for (const ch of [...gb2312L2, ...gb2312Symbols, ...usedChars]) put(ch);
// 保证中文标点与全角符号一定在 ext 分片
for (const ch of range(0x3000, 0x303f)) shardChars['wenkai-cjk-ext'].add(ch);
for (const ch of range(0xff00, 0xffef)) shardChars['wenkai-cjk-ext'].add(ch);

function* range(a, b) {
  for (let i = a; i <= b; i += 1) yield String.fromCodePoint(i);
}

// 码点序列 → pyftsubset --unicodes-file 内容（连续段合并为 a-b 区间）。
// 走文件而不是命令行参数：码点数量大，命令行长度与转义都不可靠。
const toUnicodesArg = (chars) => {
  const points = [...new Set([...chars].map((ch) => ch.codePointAt(0)))].sort((a, b) => a - b);
  const parts = [];
  let start = points[0];
  let prev = points[0];
  for (const p of points.slice(1)) {
    if (p === prev + 1) {
      prev = p;
      continue;
    }
    parts.push(start === prev ? hex(start) : `${hex(start)}-${hex(prev)}`);
    start = p;
    prev = p;
  }
  parts.push(start === prev ? hex(start) : `${hex(start)}-${hex(prev)}`);
  return parts.join(' ');
};
const hex = (n) => n.toString(16).toUpperCase().padStart(4, '0');

const unicodeRange = (chars) => {
  const points = [...new Set([...chars].map((ch) => ch.codePointAt(0)))].sort((a, b) => a - b);
  const parts = [];
  let start = points[0];
  let prev = points[0];
  for (const p of points.slice(1)) {
    if (p === prev + 1) {
      prev = p;
      continue;
    }
    parts.push(start === prev ? u(start) : `${u(start)}-${u(prev)}`);
    start = p;
    prev = p;
  }
  parts.push(start === prev ? u(start) : `${u(start)}-${u(prev)}`);
  return parts.join(', ');
};
const u = (n) => `U+${hex(n)}`;

// —— 执行子集化 ——
const results = [];
const listFile = path.join(OUT_DIR, '.subset-unicodes.txt');
for (const [name, chars] of Object.entries(shardChars)) {
  const out = path.join(OUT_DIR, `${name}.woff2`);
  fs.writeFileSync(listFile, toUnicodesArg(chars), 'utf8');
  const args = [
    '-m',
    'fontTools.subset',
    SRC_FONT,
    `--unicodes-file=${listFile}`,
    '--flavor=woff2',
    '--layout-features=*',
    '--glyph-names',
    '--symbol-cmap',
    '--legacy-cmap',
    '--notdef-glyph',
    '--notdef-outline',
    '--recommended-glyphs',
    '--name-IDs=*',
    '--name-languages=*',
    `--output-file=${out}`,
  ];
  execFileSync('py', args, { stdio: 'inherit' });
  results.push({ name, chars: chars.size, file: out, bytes: fs.statSync(out).size, range: unicodeRange(chars) });
}
fs.rmSync(listFile, { force: true });

// 生成 src/styles/fonts.css（@font-face + unicode-range 声明），一键可复现。
const SHARD_LABELS = {
  'wenkai-latin': '拉丁分片',
  'wenkai-cjk-common': '常用汉字分片（GB2312 一级）',
  'wenkai-cjk-ext': '生僻汉字与符号分片（GB2312 二级 + 站内字符）',
};
const faces = results
  .map(
    (r) => `/* ${SHARD_LABELS[r.name] || r.name}：${r.chars} 字符 */
@font-face {
  font-family: "LXGW WenKai Mono";
  src: url("/fonts/${r.name}.woff2") format("woff2");
  font-weight: normal;
  font-style: normal;
  font-display: swap;
  unicode-range: ${r.range};
}`,
  )
  .join('\n\n');
const header =
  '/* 霞鹜文楷等宽字体分片（由 scripts/subset-font.mjs 从完整 TTF 生成）：\n' +
  '   拉丁 / 常用汉字 / 生僻汉字三片按 unicode-range 按需加载，\n' +
  '   首屏只下载常用汉字片。子集外字符由 CSS 回退栈渲染。 */\n\n';
fs.writeFileSync(path.join(ROOT, 'src', 'styles', 'fonts.css'), `${header}${faces}\n`, 'utf8');

// 输出汇总，便于核对
const total = results.reduce((sum, r) => sum + r.bytes, 0);
for (const r of results) {
  console.log(`${r.name}: ${r.chars} 字符, ${(r.bytes / 1024 / 1024).toFixed(2)} MB`);
}
console.log(`合计: ${(total / 1024 / 1024).toFixed(2)} MB`);
console.log('src/styles/fonts.css 已重新生成');
