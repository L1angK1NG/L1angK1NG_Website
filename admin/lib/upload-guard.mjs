// 上传文件内容校验（自 server.mjs 抽出，便于单元测试）：
//   1. 文件头（magic number）必须与扩展名一致，防止任意内容伪装成图片；
//   2. SVG 必须剥离脚本能力（<script>、事件属性、javascript:/data: 链接、
//      <foreignObject>），防止上传面成为存储型 XSS 跳板。
// 仅管理员可上传，但账号一旦被盗不能成为跳板；剥离后图形仍可正常显示。

export const MAGIC_CHECKS = {
  '.png': (b) => b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  '.jpg': (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  '.jpeg': (b) => MAGIC_CHECKS['.jpg'](b),
  '.gif': (b) =>
    b.length > 6 &&
    (b.subarray(0, 6).toString('latin1') === 'GIF87a' || b.subarray(0, 6).toString('latin1') === 'GIF89a'),
  '.webp': (b) =>
    b.length > 12 &&
    b.subarray(0, 4).toString('latin1') === 'RIFF' &&
    b.subarray(8, 12).toString('latin1') === 'WEBP',
  '.avif': (b) =>
    b.length > 12 &&
    b.subarray(4, 8).toString('latin1') === 'ftyp' &&
    /avi[fs]/.test(b.subarray(8, 12).toString('latin1')),
  '.ico': (b) => b.length > 4 && b[0] === 0x00 && b[1] === 0x00 && b[2] === 0x01 && b[3] === 0x00,
  '.svg': (b) =>
    /^\s*(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!DOCTYPE[^>]*>\s*)?<svg[\s>]/i.test(
      b.subarray(0, 1024).toString('utf8'),
    ),
};

export function looksLikeSvg(buf) {
  return MAGIC_CHECKS['.svg'](buf);
}

// SVG 脚本能力剥离：<script>、事件属性（on*）、javascript:/data:/vbscript: 链接、
// <foreignObject> 与外部引用一律清除或置空。
export function sanitizeSvg(buf) {
  let text = buf.toString('utf8');
  text = text.replace(/<\s*script\b[\s\S]*?<\s*\/\s*script\s*>/gi, '');
  text = text.replace(/<\s*script\b[^>]*\/?\s*>/gi, '');
  text = text.replace(/<\s*foreignObject\b[\s\S]*?<\s*\/\s*foreignObject\s*>/gi, '');
  text = text.replace(
    /<\s*[^>]*\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi,
    (m) => m.replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, ''),
  );
  text = text.replace(
    /\s(?:xlink:)?href\s*=\s*("|')?\s*(?:javascript|data|vbscript):[^"'>\s]*("|')?/gi,
    ' href=""',
  );
  text = text.replace(
    /\s(?:xlink:)?src\s*=\s*("|')?\s*(?:javascript|data|vbscript):[^"'>\s]*("|')?/gi,
    ' src=""',
  );
  return Buffer.from(text, 'utf8');
}
