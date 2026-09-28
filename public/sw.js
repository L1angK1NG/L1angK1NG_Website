// Kill switch: this site does not use a service worker. If a previous site
// version registered one under this path, this file replaces it, wipes its
// caches, unregisters itself and reloads open tabs onto the network.
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
