// Harden post-content images:
// - referrerpolicy="no-referrer" bypasses image-host hotlink protection (防盗链)
// - loading="lazy" / decoding="async" avoid eager-loading remote images and reduce jank
const visit = (node, fn) => {
  if (!node) {
    return;
  }

  if (node.type === 'element') {
    fn(node);
  }

  if (Array.isArray(node.children)) {
    for (const child of node.children) {
      visit(child, fn);
    }
  }
};

export default function rehypeImgAttrs() {
  return (tree) => {
    visit(tree, (node) => {
      if (node.tagName !== 'img') {
        return;
      }

      node.properties = node.properties ?? {};
      node.properties.referrerPolicy = 'no-referrer';
      node.properties.loading ??= 'lazy';
      node.properties.decoding ??= 'async';
    });
  };
}
