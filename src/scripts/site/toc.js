// 文章目录（TOC）滚动高亮。
export function initToc(signal) {
  const links = [...document.querySelectorAll('.toc a[href^="#"]')];

  if (!links.length) {
    return;
  }

  const items = links
    .map((link) => {
      const id = decodeURIComponent(link.getAttribute('href').slice(1));
      return { link, heading: document.getElementById(id) };
    })
    .filter((item) => item.heading);

  if (!items.length) {
    return;
  }

  let current = null;
  const setActive = (link) => {
    if (current === link) {
      return;
    }
    current?.classList.remove('is-active');
    link.classList.add('is-active');
    current = link;
  };

  let ticking = false;
  const sync = () => {
    ticking = false;
    const offset = 130;
    let active = items[0].link;
    for (const { link, heading } of items) {
      if (heading.getBoundingClientRect().top <= offset) {
        active = link;
      } else {
        break;
      }
    }
    // 滚动到底部时，最后的标题可能永远不会越过偏移阈值
    // （页面已无剩余滚动量）。此时强制激活最后一项。
    if (window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 60) {
      active = items[items.length - 1].link;
    }
    setActive(active);
  };

  window.addEventListener(
    'scroll',
    () => {
      if (!ticking) {
        ticking = true;
        window.requestAnimationFrame(sync);
      }
    },
    { passive: true, signal },
  );
  sync();
}
