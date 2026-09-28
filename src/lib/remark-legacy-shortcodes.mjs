const shortcodePattern = /{%\s*([\s\S]*?)\s*%}/g;

const escapeHtml = (value = '') =>
  String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

const splitArgs = (value = '') =>
  value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

const parseKeyValues = (args) =>
  args.reduce((acc, arg) => {
    const index = arg.indexOf('=');

    if (index === -1) {
      return acc;
    }

    const key = arg.slice(0, index).trim();
    const value = arg.slice(index + 1).trim();
    acc[key] = value;
    return acc;
  }, {});

const getUrl = (value = '') => {
  const match = value.match(/https?:\/\/[^\s,]+/);
  return match?.[0] ?? '';
};

const getInlineImageStyle = (value = '') => {
  const height = value.match(/height\s*=\s*([^,\s]+)/i)?.[1] ?? value.match(/\s(\d+px)\s*$/i)?.[1];
  return height ? ` style="height: ${escapeHtml(height)}; width: auto;"` : '';
};

export const shortcodeToHtml = (raw) => {
  const [command = '', ...restParts] = raw.trim().split(/\s+/);
  const rest = restParts.join(' ');
  const normalized = command.toLowerCase();

  if (
    [
      'sitegroup',
      'endsitegroup',
      'btns',
      'endbtns',
      'gallery',
      'endgallery',
    ].includes(normalized)
  ) {
    return '';
  }

  if (normalized === 'inlineimg' || normalized === 'inlineimage') {
    const url = getUrl(rest);

    if (!url) {
      return '';
    }

    return `<img class="legacy-inline-image" src="${escapeHtml(url)}" alt="" loading="lazy"${getInlineImageStyle(rest)} />`;
  }

  if (normalized === 'folding') {
    const args = splitArgs(rest);
    const summary = args[1] ?? args[0] ?? '展开内容';
    return `<details class="legacy-folding"><summary>${escapeHtml(summary)}</summary>`;
  }

  if (normalized === 'endfolding') {
    return '</details>';
  }

  if (normalized === 'psw') {
    return `<code class="legacy-secret">${escapeHtml(rest)}</code>`;
  }

  if (normalized === 'cell') {
    const [label = '查看链接', url = '#'] = splitArgs(rest);
    return `<a class="legacy-button" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`;
  }

  if (normalized === 'link') {
    const [label = '查看链接', description = '', url = '#'] = splitArgs(rest);
    return `<a class="legacy-link-card" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer"><span>${escapeHtml(label)}</span><small>${escapeHtml(description)}</small></a>`;
  }

  if (normalized === 'site') {
    const args = splitArgs(rest);
    const title = args[0] ?? '查看链接';
    const values = parseKeyValues(args.slice(1));
    const url = values.url ?? '#';
    const description = values.description ?? '';
    const screenshot = values.screenshot ?? values.avatar;
    const image = screenshot
      ? `<img src="${escapeHtml(screenshot)}" alt="" loading="lazy" />`
      : '';

    return `<a class="legacy-site-card" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${image}<span><strong>${escapeHtml(title)}</strong><small>${escapeHtml(description)}</small></span></a>`;
  }

  return '';
};

const transformTextNode = (node) => {
  const value = node.value;

  if (!shortcodePattern.test(value)) {
    shortcodePattern.lastIndex = 0;
    return [node];
  }

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
      nodes.push({ type: 'html', value: html });
    }

    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < value.length) {
    nodes.push({ type: 'text', value: value.slice(lastIndex) });
  }

  return nodes;
};

const serializeInline = (node) => {
  if (!node) {
    return '';
  }

  if (typeof node.value === 'string') {
    return node.value;
  }

  if (node.type === 'link') {
    return node.url ?? node.children?.map(serializeInline).join('') ?? '';
  }

  if (Array.isArray(node.children)) {
    return node.children.map(serializeInline).join('');
  }

  return '';
};

const transformTree = (node) => {
  if (!node || !Array.isArray(node.children)) {
    return;
  }

  node.children = node.children.flatMap((child) => {
    if (child.type === 'paragraph') {
      const serialized = child.children.map(serializeInline).join('');

      if (serialized.includes('{%') && serialized.includes('%}')) {
        child.children = transformTextNode({ type: 'text', value: serialized });
        return [child];
      }
    }

    if (child.type === 'text') {
      return transformTextNode(child);
    }

    transformTree(child);
    return [child];
  });
};

export default function remarkLegacyShortcodes() {
  return (tree) => {
    transformTree(tree);
  };
}
