// 熔断开关：本站不使用 service worker。如果之前版本的站点在此路径注册过
// service worker，本文件会将其替换，清空其全部缓存，注销自身，并把已打开
// 的标签页重新加载为直接走网络。
self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      try {
        const keys = await caches.keys();
        await Promise.all(keys.map((key) => caches.delete(key)));
      } catch {}
      try {
        await self.registration.unregister();
      } catch {}
      const tabs = await self.clients.matchAll({ type: 'window' });
      tabs.forEach((tab) => tab.navigate(tab.url));
    })(),
  );
});
