// LRC 歌词解析（纯函数，浏览器与 Node 共用）。
// 形如 [mm:ss.xx] 歌词文本；一行可带多个时间标签（复用同一句）；
// [ar:] / [ti:] 等元信息标签与空时间行自动忽略。
export function parseLrc(text) {
  const lines = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const stamps = [...raw.matchAll(/\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g)];
    if (!stamps.length) continue;
    const content = raw.replace(/\[[^\]]*\]/g, '').trim();
    for (const m of stamps) {
      const frac = m[3] ? Number(`0.${m[3]}`) : 0;
      lines.push({ time: Number(m[1]) * 60 + Number(m[2]) + frac, text: content });
    }
  }
  return lines.sort((a, b) => a.time - b.time);
}
