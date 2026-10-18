/* AxiX Service Worker —— 静态资源缓存加速
 * 策略：
 *  - /api/*          → 永远直连网络，绝不缓存（数据实时性优先）
 *  - 页面导航 (HTML)  → 网络优先，缓存兜底（离线也能打开壳）
 *  - /js/ /styles/ /vendor/ /assets/ → 缓存优先 + 后台更新（文件带 ?v= 版本号，URL 变化即拉新）
 *  - 其余同源 GET     → 不接管，走浏览器默认行为
 * 注意：修改静态文件需升级对应 ?v= 版本号，或递增 SW_VERSION 重建缓存。
 */
const SW_VERSION = 'axix-static-v8';
const STATIC_PREFIXES = ['/js/', '/styles/', '/vendor/', '/assets/'];

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key !== SW_VERSION).map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  let url;
  try { url = new URL(request.url); } catch { return; }
  if (url.origin !== location.origin) return;
  // API 与管理后台一律直连，不缓存
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/admin')) return;

  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      // 网络优先，4s 超时回退缓存：弱网下 fetch 挂起不再无限等待
      const fresh = await Promise.race([
        fetch(request).catch(() => null),
        new Promise(resolve => setTimeout(() => resolve(null), 4000))
      ]);
      if (fresh && fresh.ok) {
        const cache = await caches.open(SW_VERSION);
        cache.put(request, fresh.clone());
        return fresh;
      }
      const cached = await caches.match(request);
      if (cached) return cached;
      if (fresh) return fresh;
      return new Response('<h1>Offline</h1><p>Network unavailable, please retry later.</p>',
        { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    })());
    return;
  }

  if (STATIC_PREFIXES.some(prefix => url.pathname.startsWith(prefix))) {
    event.respondWith((async () => {
      const cache = await caches.open(SW_VERSION);
      const cached = await cache.match(request);
      // Versioned URLs change with each release. Re-fetching cached assets competes with login on mobile.
      if (cached && url.searchParams.has('v')) return cached;
      const network = fetch(request)
        .then(response => {
          if (response && response.ok) cache.put(request, response.clone());
          return response;
        })
        .catch(() => null);
      event.waitUntil(network);
      return cached || (await network) || new Response('', { status: 504, statusText: 'Offline' });
    })());
  }
});
