// 进场显现：首屏按滚动位置分批显现内容元素；ClientRouter 换页时在
// after-swap（早于浏览器捕获进场帧）立即显现全部内容，避免页面级淡入淡出
// 把新页面以「隐藏待显现」状态截进快照。

const SELECTOR =
  '.hero__intro > *, .hero__picks, .section__header, .section__more, .post-row, .related-posts, .post-nav, .article__header > *, .article__main > .article__cover, .proj-section__head, .proj, .page-header, .archive-summary, .archive-year__head, .about__intro > *, .note';

// 换页回调里先显现每个进场子元素，再让过渡接管：swap 回调无需读取几何信息，
// 也不会延长过渡的空白间隔。
export function forceRevealIncoming() {
  const visible = [...document.querySelectorAll(SELECTOR)];

  visible.forEach((el) => {
    el.style.transition = 'none';
    el.classList.add('is-revealed');
    el.dataset.revealed = '1';
  });

  window.requestAnimationFrame(() => {
    visible.forEach((el) => {
      el.style.transition = '';
    });
  });
}

// 基于位置的显现：对快速滚动跳转、锚点链接和滚动位置恢复都稳健
// （位于视口内/以上的内容都会显现；被跳过的屏幕外内容直接出现，不再重复动画）。
export function initReveal(signal) {
  const targets = [...document.querySelectorAll(SELECTOR)];

  if (!targets.length) {
    return;
  }

  let ticking = false;
  const routeSwap = document.documentElement.hasAttribute('data-astro-transition');
  const reveal = () => {
    ticking = false;
    const line = window.innerHeight * 0.94;
    const batch = [];
    for (const el of targets) {
      if (el.dataset.revealed) {
        continue;
      }
      if (el.getBoundingClientRect().top < line) {
        batch.push(el);
      }
    }
    // 只对同时进入视口的一批元素做错峰延迟（例如页面加载时的那批）。
    batch.forEach((el, index) => {
      if (routeSwap) {
        el.style.transition = 'none';
        window.requestAnimationFrame(() => {
          el.style.transition = '';
        });
      } else {
        el.style.setProperty('--reveal-delay', Math.min(index, 6) * 0.06 + 's');
      }
      el.classList.add('is-revealed');
      el.dataset.revealed = '1';
    });
  };
  const onScroll = () => {
    if (!ticking) {
      ticking = true;
      window.requestAnimationFrame(reveal);
    }
  };

  window.addEventListener('scroll', onScroll, { passive: true, signal });
  window.addEventListener('resize', onScroll, { passive: true, signal });
  window.addEventListener('load', reveal, { signal });
  window.requestAnimationFrame(reveal);
}
