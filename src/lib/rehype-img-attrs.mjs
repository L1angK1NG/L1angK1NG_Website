// 加固正文中的图片，并优化图片呈现：
// - referrerpolicy="no-referrer" 可绕过图床的防盗链（hotlink protection）
// - loading="lazy" / decoding="async" 避免急切加载远程图片，并减少卡顿
// - 独占一段的图片升级为 <figure>：写在标题位（Markdown 图片 "标题"）的文字
//   渲染为居中图注 <figcaption>，让「图 + 说明」成为一个整体
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

const isImage = (node) => node?.type === 'element' && node.tagName === 'img';

export default function rehypeImgAttrs() {
  return (tree) => {
    // 第一遍：给所有图片补齐加载属性。
    visit(tree, (node) => {
      if (node.tagName !== 'img') {
        return;
      }

      node.properties = node.properties ?? {};
      node.properties.referrerPolicy = 'no-referrer';
      node.properties.loading ??= 'lazy';
      node.properties.decoding ??= 'async';
    });

    // 第二遍：独占一段的图片（<p> 里只有一个 <img>）换成 <figure>，
    // 图片的 title（Markdown 的 "标题" 位）转为图注展示。
    visit(tree, (node) => {
      if (node.tagName !== 'p' || node.children?.length !== 1 || !isImage(node.children[0])) {
        return;
      }

      const img = node.children[0];
      const title = img.properties?.title;
      node.tagName = 'figure';
      if (title) {
        // title 从图片上移除（浏览器原生 tooltip 会与图注重复），转为图注文本。
        const { title: _removed, ...rest } = img.properties;
        img.properties = rest;
        node.children = [
          img,
          {
            type: 'element',
            tagName: 'figcaption',
            properties: {},
            children: [{ type: 'text', value: String(title) }],
          },
        ];
      }
    });
  };
}
