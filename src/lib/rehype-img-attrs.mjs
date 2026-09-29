// 加固正文中的图片：
// - referrerpolicy="no-referrer" 可绕过图床的防盗链（hotlink protection）
// - loading="lazy" / decoding="async" 避免急切加载远程图片，并减少卡顿
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
