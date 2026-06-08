const CACHE_NAME = 'codex-console-v106';
const ASSETS = ['/', '/index.html', '/styles.css?v=84', '/app.js?v=97', '/message-scheduler.js?v=2', '/browser-utils.js?v=1', '/format-utils.js?v=1', '/message-utils.js?v=1', '/message-view.js?v=3', '/prompt-actions.js?v=4', '/queue-view.js?v=3', '/skill-view.js?v=3', '/manifest.json?v=2'];
const CACHEABLE_PATHS = new Set(['/', '/index.html', '/styles.css', '/app.js', '/message-scheduler.js', '/browser-utils.js', '/format-utils.js', '/message-utils.js', '/message-view.js', '/prompt-actions.js', '/queue-view.js', '/skill-view.js', '/manifest.json']);

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;
  if (event.request.method !== 'GET') return;
  if (!CACHEABLE_PATHS.has(url.pathname)) return;
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy)).catch(() => {});
        return response;
      })
      .catch(() => caches.match(event.request).then((cached) => cached || caches.match('/index.html')))
  );
});
