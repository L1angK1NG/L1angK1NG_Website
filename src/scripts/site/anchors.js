// 标题锚点：正文 h2 / h3 悬停或键盘聚焦时露出「#」直达链接，
// 点击后地址栏带上该节锚点（与目录条目共用同一套 id），方便分享某一节。
export function initHeadingAnchors(signal) {
  const headings = document.querySelectorAll('.post-content :is(h2, h3)[id]');

  headings.forEach((heading) => {
    if (heading.querySelector('.heading-anchor')) {
      return;
    }

    const anchor = document.createElement('a');
    anchor.className = 'heading-anchor';
    anchor.href = `#${heading.id}`;
    anchor.textContent = '#';
    anchor.setAttribute('aria-label', '本节链接');
    heading.append(anchor);
  });

  // 点击时把锚点写进地址栏但不触发平滑长跳（此时读者就在本节）。
  document.addEventListener(
    'click',
    (event) => {
      const link = event.target.closest?.('.heading-anchor');
      if (!link) {
        return;
      }
      event.preventDefault();
      const url = new URL(window.location.href);
      url.hash = link.hash;
      window.history.replaceState(null, '', url);
    },
    { signal },
  );
}
