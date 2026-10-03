// 本站不提供 service worker。清除此前版本的站点（或同一 localhost 端口上
// 的其他项目）遗留的任何注册——过期的 SW 会返回过时的 CSS/JS，并破坏页面过渡。
export function initSwCleanup() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker
    .getRegistrations()
    .then((regs) => {
      if (!regs.length) return;
      regs.forEach((reg) => reg.unregister());
      if (window.caches) {
        caches.keys().then((keys) => keys.forEach((key) => caches.delete(key)));
      }
    })
    .catch(() => {});
}
