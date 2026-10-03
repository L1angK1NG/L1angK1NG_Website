// 站点外壳脚本装配：主题切换、显现动画、复制代码、灯箱、阅读进度、目录高亮、
// 访问打点、快捷键与 service worker 清理。
//
// 生命周期：打包成单个可缓存模块（不再随每页 HTML 下发），只执行一次；
// 每次 ClientRouter 换页在 astro:after-swap（新帧捕获前）用新的
// AbortController 重新绑定页面元素级监听，与原内联 data-astro-rerun 脚本
// 的时机等价。主题初始化等必须阻塞首帧的极小片段仍在 <head> 内联。
import { forceRevealIncoming, initReveal } from './reveal.js';
import { initImgFade } from './img-fade.js';
import { initThemeToggle } from './theme-toggle.js';
import { initCopyCode } from './copy-code.js';
import { initLightbox } from './lightbox.js';
import { initProgress } from './progress.js';
import { initToc } from './toc.js';
import { initShortcuts } from './shortcuts.js';
import { initSwCleanup } from './sw-cleanup.js';
import { trackView } from './tracking.js';

let controller = null;

const initPage = () => {
  controller?.abort();
  controller = new AbortController();
  const signal = controller.signal;

  initThemeToggle(signal);
  initCopyCode(signal);
  initLightbox(signal);
  initProgress(signal);
  initToc(signal);
  initReveal(signal);
  initImgFade();
  trackView();
};

// 首次加载立即初始化；文档级行为只绑定一次。
initPage();
initShortcuts();
initSwCleanup();

document.addEventListener('astro:after-swap', () => {
  // 先强制显现新页面内容（早于进场帧捕获），再重新绑定页面元素级监听。
  forceRevealIncoming();
  initPage();
});
