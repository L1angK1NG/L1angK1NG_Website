// 共享的浏览器端 HTML 白名单净化（DOM 解析 + 逐节点过滤）。
// 前台评论渲染与后台 Markdown 预览共用：任何来源的 HTML 在进入 innerHTML
// 之前都先过这一层，脚本能力（<script>、on* 事件、javascript: 链接）全部剥离。
// 依赖浏览器 DOM（document/template），仅供客户端脚本 import。

const DEFAULT_ALLOWED_TAGS = new Set([
  'A',
  'B',
  'BLOCKQUOTE',
  'BR',
  'CODE',
  'DEL',
  'EM',
  'I',
  'IMG',
  'LI',
  'OL',
  'P',
  'PRE',
  'S',
  'SPAN',
  'STRONG',
  'UL',
]);

// 后台预览还要展示标题、分隔线、表格、图片面板等 Markdown 常见输出。
const EXTENDED_TAGS = new Set([
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'HR',
  'TABLE',
  'THEAD',
  'TBODY',
  'TR',
  'TH',
  'TD',
  'INPUT', // 任务列表复选框
  'SMALL',
  'SUP',
  'SUB',
  'MARK',
  'CITE',
  'KBD',
  'ABBR',
  'FIGURE', // 文中插图（尺寸/对齐/图注）
  'FIGCAPTION',
]);

export const safeUrl = (value, protocols = ['http:', 'https:']) => {
  try {
    const url = new URL(value, location.origin);
    return protocols.includes(url.protocol);
  } catch {
    return false;
  }
};

// 净化一段 HTML：allowedTags 之外的标签降级为纯文本，属性白名单化，
// 链接强制 target=_blank + noopener，图片强制 lazy + no-referrer。
export function sanitizeHtml(html, { extended = false } = {}) {
  const allowedTags = extended
    ? new Set([...DEFAULT_ALLOWED_TAGS, ...EXTENDED_TAGS])
    : DEFAULT_ALLOWED_TAGS;

  const template = document.createElement('template');
  template.innerHTML = String(html || '');

  const walk = (node) => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === Node.COMMENT_NODE) {
        child.remove();
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;

      if (!allowedTags.has(child.tagName)) {
        child.replaceWith(document.createTextNode(child.textContent || ''));
        continue;
      }

      for (const attr of [...child.attributes]) {
        const name = attr.name.toLowerCase();
        const value = attr.value;
        const isLink = child.tagName === 'A' && ['href', 'title'].includes(name);
        const isImage = child.tagName === 'IMG' && ['src', 'alt', 'title'].includes(name);
        // class 只对纯样式/代码容器放行（figure 的 class 编码尺寸与对齐），
        // class 本身不可执行，样式规则都来自站点自身样式表。
        const isClass = ['CODE', 'PRE', 'SPAN', 'FIGURE'].includes(child.tagName) && name === 'class';
        // 任务列表复选框只保留 type=checkbox 与勾选状态
        const isCheckbox =
          child.tagName === 'INPUT' &&
          ((name === 'type' && value === 'checkbox') || name === 'checked' || name === 'disabled');

        if (
          name.startsWith('on') ||
          (!isLink && !isImage && !isClass && !isCheckbox) ||
          (name === 'href' && !safeUrl(value, ['http:', 'https:', 'mailto:'])) ||
          (name === 'src' && !safeUrl(value))
        ) {
          child.removeAttribute(attr.name);
        }
      }

      if (child.tagName === 'A' && child.getAttribute('href')) {
        child.setAttribute('target', '_blank');
        child.setAttribute('rel', 'noopener noreferrer');
      }
      if (child.tagName === 'IMG' && child.getAttribute('src')) {
        child.setAttribute('loading', 'lazy');
        child.setAttribute('referrerpolicy', 'no-referrer');
      }

      walk(child);
    }
  };

  walk(template.content);
  return template.innerHTML;
}

// HTML 特殊字符转义（用于把纯文本插入 HTML 片段）。
export const esc = (s) =>
  String(s == null ? '' : s).replace(/[&<>"']/g, (m) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]),
  );
