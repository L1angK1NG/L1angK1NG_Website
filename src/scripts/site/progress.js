// 阅读进度条（文章页顶部）与「回到顶部」按钮。
export function initProgress(signal) {
  const bar = document.querySelector('[data-reading-progress]');
  const article = document.querySelector('.article');
  const toTop = document.querySelector('[data-to-top]');
  let ticking = false;

  const update = () => {
    ticking = false;
    const scrollY = window.scrollY;

    if (bar && article) {
      const start = article.offsetTop;
      const total = article.offsetHeight - window.innerHeight;
      const progress = total > 0 ? (scrollY - start) / total : 0;
      bar.style.transform = `scaleX(${Math.min(1, Math.max(0, progress))})`;
    }

    if (toTop) {
      toTop.classList.toggle('is-visible', scrollY > 600);
    }
  };

  const onScroll = () => {
    if (!ticking) {
      ticking = true;
      window.requestAnimationFrame(update);
    }
  };

  window.addEventListener('scroll', onScroll, { passive: true, signal });
  window.addEventListener('resize', onScroll, { passive: true, signal });
  update();

  toTop?.addEventListener('click', () => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, { signal });
}
