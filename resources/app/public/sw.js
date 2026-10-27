/* AxiX Service Worker —— 静态资源缓存加速
 * 策略：
 *  - /api/*          → 永远直连网络，绝不缓存（数据实时性优先）
 *  - 页面导航 (HTML)  → 网络优先，缓存兜底（离线也能打开壳）
 *  - /js/ /styles/ /vendor/ /assets/ → 缓存优先 + 后台更新（文件带 ?v= 版本号，URL 变化即拉新）
 *  - 其余同源 GET     → 不接管，走浏览器默认行为
 * 注意：修改静态文件需升级对应 ?v= 版本号，或递增 SW_VERSION 重建缓存。
 */
const SW_VERSION = 'axix-static-v14';
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
  // API 与管理后台一律直连，不缓存，包括编码后的入口路径。
  let pathname;
  try { pathname = decodeURIComponent(url.pathname).replace(/\\/g, '/').replace(/\/+/g, '/').toLowerCase(); }
  catch { return; }
  if (pathname.startsWith('/api/') || pathname.startsWith('/admin')
    || ['/funds-admin.html', '/withdraw-admin.html'].includes(pathname)) return;

  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      // 网络优先：8s 超时；首轮失败再补一次尝试，避免服务器繁忙（如重启初始化期）误判离线。
      // cache:'no-cache' 强制绕过浏览器 HTTP 缓存重新协商 HTML，防止启发式缓存让用户长时间停留在旧页面。
      const tryNetwork = (ms) => Promise.race([
        fetch(request, { cache: 'no-cache' }).catch(() => null),
        new Promise(resolve => setTimeout(() => resolve(null), ms))
      ]);
      let fresh = await tryNetwork(8000);
      if (!fresh) fresh = await tryNetwork(8000);
      if (fresh && fresh.ok) {
        const cache = await caches.open(SW_VERSION);
        cache.put(request, fresh.clone());
        return fresh;
      }
      const cached = await caches.match(request);
      if (cached) return cached;
      if (fresh) return fresh;
      // 无缓存且网络暂不可用：中文提示页，恢复联网后自动重试，也可手动点击，不再是死页。
      return new Response(
        '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
        + '<meta name="viewport" content="width=device-width,initial-scale=1">'
        + '<title>网络繁忙</title>'
        + '<style>body{margin:0;font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;'
        + 'background:#0e1512;color:#e7f1ef;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:24px}'
        + '.box{text-align:center;max-width:320px}'
        + 'h1{font-size:20px;margin:0 0 10px;font-weight:700}'
        + 'p{font-size:13px;line-height:1.7;color:#9fb3ae;margin:0 0 20px}'
        + 'button{background:#1f8a78;color:#fff;border:0;border-radius:999px;padding:12px 34px;font-size:15px;font-weight:600}'
        + '.tip{margin-top:16px;font-size:11px;color:#6c7f7a}</style></head>'
        + '<body><div class="box"><h1>网络繁忙，正在重连…</h1>'
        + '<p>当前访问人数较多或网络不稳定，请稍候，页面会自动刷新。</p>'
        + '<button onclick="location.reload()">手动刷新</button>'
        + '<div class="tip">若长时间无法打开，请切换 Wi-Fi / 流量后重试</div></div>'
        + '<script>var n=0;var t=setInterval(function(){n++;'
        + 'if(navigator.onLine){location.reload()}else if(n>=24){clearInterval(t)}},2500);'
        + 'window.addEventListener("online",function(){location.reload()});<' + '/script>'
        + '</body></html>',
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
