// 供编辑器使用的服务端 Markdown 预览。复用博客自带的短代码转换器，使 {% %}
// 块的呈现与构建后的效果一致，再用 marked 渲染 Markdown。权威的渲染结果仍
// 以 Astro 构建为准；这里只是一个快速且足够忠实的写作辅助。
import { marked } from 'marked';
import { shortcodeToHtml } from '../../src/lib/remark-legacy-shortcodes.mjs';

const shortcodePattern = /{%\s*([\s\S]*?)\s*%}/g;

export function renderPreview(markdown) {
  const source = String(markdown ?? '');
  // 先将短代码展开为原始 HTML；marked 会原样透传这些 HTML。
  const withShortcodes = source.replace(shortcodePattern, (_match, inner) => {
    try {
      return shortcodeToHtml(inner) || '';
    } catch {
      return '';
    }
  });
  const html = marked.parse(withShortcodes, { async: false, gfm: true, breaks: true });
  return String(html);
}
