const CACHE_NAME = 'propertyflow-shell-v2';
const SHELL_PATHS = [
  '/',
  '/index.html',
  '/features.js',
  '/notifications.js',
  '/manifest.webmanifest',
  '/propertyflow-icon-192.png',
  '/propertyflow-icon-512.png',
  '/propertyflow-icon.svg',
  '/flowchart.svg'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(SHELL_PATHS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys
        .filter(key => key.startsWith('propertyflow-shell-') && key !== CACHE_NAME)
        .map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const response = await fetch(request);
          if (response.ok) {
            const cache = await caches.open(CACHE_NAME);
            await cache.put('/', response.clone());
          }
          return response;
        } catch {
          return (await caches.match(request)) || (await caches.match('/'));
        }
      })()
    );
    return;
  }

  if (!SHELL_PATHS.includes(url.pathname)) return;
  event.respondWith(
    (async () => {
      const cached = await caches.match(request);
      try {
        const response = await fetch(request);
        if (response.ok) {
          const cache = await caches.open(CACHE_NAME);
          await cache.put(request, response.clone());
        }
        return response;
      } catch {
        if (cached) return cached;
        throw new Error(`PropertyFlow offline resource is not cached: ${url.pathname}`);
      }
    })()
  );
});
