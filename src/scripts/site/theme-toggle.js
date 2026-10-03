// 主题切换按钮：三态循环（跟随系统 → 浅色 → 深色），切换时以扩张的圆形
// 从按钮位置扫出新主题（View Transition API），不支持时退化为快速渐变。

const STORAGE_KEY = 'blog-theme';
const LIGHT_COLOR = '#f8f7f4';
const DARK_COLOR = '#0e1116';

const getMode = () => {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'light' || stored === 'dark' || stored === 'auto') return stored;
  } catch {
  }
  return 'auto';
};
const setStoredMode = (mode) => {
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
  }
};
const getSystemTheme = () =>
  window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
const effectiveTheme = (mode) => (mode === 'auto' ? getSystemTheme() : mode);

export function initThemeToggle(signal) {
  const button = document.querySelector('[data-theme-toggle]');
  const themeColor = document.querySelector('#theme-color');

  const applyMode = (mode, persist = true) => {
    const theme = effectiveTheme(mode);
    document.documentElement.dataset.theme = theme;
    // 与 head 内的 restoreTheme 一致：模式驱动按钮图标，首帧即正确
    document.documentElement.dataset.themeMode = mode;
    themeColor?.setAttribute('content', theme === 'dark' ? DARK_COLOR : LIGHT_COLOR);

    if (button) {
      // 图标显示「当前模式」（太阳=浅色 / 月亮=深色 / 显示器=跟随系统），
      // 文字提示说明当前状态与点击效果。
      const label =
        mode === 'auto'
          ? `主题跟随系统（当前${theme === 'dark' ? '深色' : '浅色'}），点击切换到${theme === 'dark' ? '浅色' : '深色'}`
          : mode === 'light'
            ? '浅色模式，点击切换到深色'
            : '深色模式，点击恢复跟随系统';
      button.setAttribute('aria-label', label);
      button.setAttribute('title', label);
    }

    if (persist) {
      setStoredMode(mode);
    }
  };

  // 注入字面百分比数值，而不是 px 值或动态变量。
  // Chrome 会按设备像素密度栅格化 view-transition 快照；
  // 因此 px 裁剪坐标在 2x 屏幕上可能以一半尺寸渲染，
  // 在快照消失前导致视口的一部分未被覆盖。
  // 精确的百分比则始终位于快照自身的坐标系内。
  const themeRevealStyle =
    document.getElementById('theme-reveal-style') ??
    (() => {
      const styleEl = document.createElement('style');
      styleEl.id = 'theme-reveal-style';
      document.head.append(styleEl);
      return styleEl;
    })();

  applyMode(getMode(), false);

  const motionOK = window.matchMedia('(prefers-reduced-motion: no-preference)').matches;
  let themeAnimTimer;
  let themeSwitching = false;
  // 循环：跟随系统 → 直接切到与当前显示相反的主题（点击必有可见变化）；
  // 手动浅色 → 深色；手动深色 → 恢复跟随系统。
  const NEXT_MODE = { light: 'dark', dark: 'auto' };
  button?.addEventListener('click', () => {
    if (themeSwitching) return;
    const mode = getMode();
    const next = mode === 'auto'
      ? (effectiveTheme('auto') === 'dark' ? 'light' : 'dark')
      : NEXT_MODE[mode] ?? 'auto';
    const root = document.documentElement;

    // 新主题以扩张的圆形从切换按钮中扫出。
    if (
      motionOK &&
      document.startViewTransition &&
      !root.hasAttribute('data-astro-transition')
    ) {
      const rect = button.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      const radius =
        Math.hypot(
          Math.max(x, window.innerWidth - x),
          Math.max(y, window.innerHeight - y),
        ) + 20;
      const xPercent = (x / window.innerWidth) * 100;
      const yPercent = (y / window.innerHeight) * 100;
      // CSS 以归一化对角线为基准解析圆形的百分比半径：
      // hypot(width, height) / sqrt(2)。
      const radiusReference =
        Math.hypot(window.innerWidth, window.innerHeight) / Math.SQRT2;
      const radiusPercent = (radius / radiusReference) * 100;

      themeSwitching = true;
      button.classList.add('is-switching');
      themeRevealStyle.textContent = `@keyframes theme-reveal { from { clip-path: circle(0 at ${xPercent.toFixed(4)}% ${yPercent.toFixed(4)}%); } to { clip-path: circle(${radiusPercent.toFixed(4)}% at ${xPercent.toFixed(4)}% ${yPercent.toFixed(4)}%); } }`;
      root.classList.add('theme-vt');
      const vt = document.startViewTransition(() => applyMode(next));
      vt.finished
        .catch(() => {})
        .finally(() => {
          themeSwitching = false;
          button.classList.remove('is-switching');
          root.classList.remove('theme-vt');
        });
      return;
    }

    applyMode(next);
    if (motionOK) {
      root.classList.remove('theme-anim');
      void root.offsetWidth;
      root.classList.add('theme-anim');
      window.clearTimeout(themeAnimTimer);
      themeAnimTimer = window.setTimeout(() => root.classList.remove('theme-anim'), 380);
    }
  }, { signal });

  // 跟随系统模式下，系统切换深浅色（如定时夜览）时页面实时跟随。
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (getMode() === 'auto') {
      applyMode('auto', false);
    }
  }, { signal });
}
