import { shortcodeToHtml } from './remark-legacy-shortcodes.mjs';

const shortcodePattern = /{%\s*([\s\S]*?)\s*%}/g;

const serialize = (node) => {
  if (!node) {
    return '';
  }

  if (node.type === 'text' || node.type === 'raw') {
    return node.value ?? '';
  }

  if (node.type === 'element' && node.tagName === 'a') {
    return node.properties?.href ?? node.children?.map(serialize).join('') ?? '';
  }

  if (Array.isArray(node.children)) {
    return node.children.map(serialize).join('');
  }

  return '';
};

const transformString = (value) => {
  shortcodePattern.lastIndex = 0;
  const nodes = [];
  let lastIndex = 0;
  let match;

  while ((match = shortcodePattern.exec(value)) !== null) {
    if (match.index > lastIndex) {
      nodes.push({ type: 'text', value: value.slice(lastIndex, match.index) });
    }

    const html = shortcodeToHtml(match[1]);

    if (html) {
      nodes.push({ type: 'raw', value: html });
    }

    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < value.length) {
    nodes.push({ type: 'text', value: value.slice(lastIndex) });
  }

  return nodes;
};

const transformTree = (node) => {
  if (!node || !Array.isArray(node.children)) {
    return;
  }

  for (const child of node.children) {
    transformTree(child);
  }

  const serialized = node.children.map(serialize).join('');

  if (serialized.includes('{%') && serialized.includes('%}')) {
    node.children = transformString(serialized);
  }
};

export default function rehypeLegacyShortcodes() {
  return (tree) => {
    transformTree(tree);
  };
}
