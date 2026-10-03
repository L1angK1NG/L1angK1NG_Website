// 主题初始化（head 内联，必须在首帧渲染前同步执行，避免深浅色闪烁）。
(() => {
  const storageKey = 'blog-theme';
  const lightColor = '#f8f7f4';
  const darkColor = '#0e1116';
  // 主题模式三态：'auto'（跟随系统，默认）/ 'light' / 'dark'。
  const getMode = () => {
    try {
      const stored = localStorage.getItem(storageKey);
      if (stored === 'light' || stored === 'dark' || stored === 'auto') return stored;
    } catch {
    }
    return 'auto';
  };
  const getSystemTheme = () =>
    window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  const restoreTheme = () => {
    const mode = getMode();
    const theme = mode === 'auto' ? getSystemTheme() : mode;
    document.documentElement.dataset.theme = theme;
    // 模式也写在 <html> 上：主题按钮图标的 CSS 以它为唯一依据，
    // 在首帧前写入保证图标不会先闪错再纠正。
    document.documentElement.dataset.themeMode = mode;
    document.documentElement.classList.add('js');
    document.querySelector('#theme-color')?.setAttribute(
      'content',
      theme === 'dark' ? darkColor : lightColor,
    );
  };

  restoreTheme();
  // ClientRouter 会替换 <html> 的属性。before-swap 在新文档替换进 DOM 之前
  // 把主题写到新文档的 <html> 上（早于任何一帧绘制），彻底消除换页瞬间
  // 深→浅的跳变；after-swap 再兜底恢复一次。
  document.addEventListener('astro:before-swap', (event) => {
    const mode = getMode();
    const theme = mode === 'auto' ? getSystemTheme() : mode;
    const root = event.newDocument?.documentElement;
    if (root) {
      root.dataset.theme = theme;
      root.dataset.themeMode = mode;
    }
  });
  document.addEventListener('astro:after-swap', restoreTheme);
})();
