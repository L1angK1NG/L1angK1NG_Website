// Server-side Markdown preview for the editor. Reuses the blog's own shortcode
// transformer so {% %} blocks look the same as they will after a build, then
// renders the Markdown with marked. The authoritative render is still the Astro
// build; this is a fast, faithful-enough writing aid.
import { marked } from 'marked';
import { shortcodeToHtml } from '../../src/lib/remark-legacy-shortcodes.mjs';

const shortcodePattern = /{%\s*([\s\S]*?)\s*%}/g;

export function renderPreview(markdown) {
  const source = String(markdown ?? '');
  // Expand shortcodes to raw HTML first; marked passes raw HTML through untouched.
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
