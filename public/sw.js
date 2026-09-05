// KuroYomi Service Worker v13
// High-performance offline caching with instant WebKit/Safari PWA launch
const CACHE_NAME = 'kuroyomi-v13';

const PRECACHE_ASSETS = [
  '/',
  '/index.html',
  '/css/brutalist.css?v=13.0',
  '/js/app.js?v=13.0',
  '/js/reader.js?v=13.0',
  '/js/tts.js?v=13.0',
  '/js/storage.js?v=13.0',
  '/js/sync.js?v=13.0',
  '/js/autoscroll.js?v=13.0',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png'
];

// Install: pre-cache application shell and skip waiting immediately
self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_ASSETS))
      .catch((err) => console.warn('[SW] Pre-cache warning:', err))
  );
});

// Message listener for skipWaiting commands
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// Activate: clean up outdated caches and claim clients immediately
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            console.log('[SW] Purging old cache:', key);
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// Fetch routing
self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);

  // Ignore non-GET requests (e.g. POST /api/* handled directly by client)
  if (request.method !== 'GET') {
    return;
  }

  // 1. Navigation / HTML requests (opening PWA standalone or reloading)
  if (request.mode === 'navigate' || request.destination === 'document') {
    event.respondWith(
      (async () => {
        // Fast path: if browser is offline, serve cached shell instantly (0ms latency)
        if (!navigator.onLine) {
          const cached = await caches.match('/index.html') || await caches.match('/');
          if (cached) return cached;
        }

        // Online path: fetch network with a strict 1500ms timeout so offline/dead-zone WebKit never stalls
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 1500);
          const networkResponse = await fetch(request, { signal: controller.signal });
          clearTimeout(timer);

          if (networkResponse && networkResponse.status === 200) {
            const copy = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return networkResponse;
        } catch (err) {
          // Network failed or timed out: fall back instantly to cached index.html
          const cached = await caches.match('/index.html') || await caches.match('/');
          if (cached) return cached;
          throw err;
        }
      })()
    );
    return;
  }

  // 2. Static Assets (CSS, JS, manifest, icons): Cache-First
  const isStaticAsset = (
    url.pathname.startsWith('/css/') ||
    url.pathname.startsWith('/js/') ||
    url.pathname.startsWith('/icons/') ||
    url.pathname === '/manifest.json'
  );

  if (isStaticAsset) {
    event.respondWith(
      caches.match(request).then((cachedResponse) => {
        if (cachedResponse) {
          // Serve from cache immediately
          if (navigator.onLine) {
            // Background revalidate if online
            fetch(request).then((networkResponse) => {
              if (networkResponse && networkResponse.status === 200) {
                caches.open(CACHE_NAME).then((cache) => cache.put(request, networkResponse));
              }
            }).catch(() => {});
          }
          return cachedResponse;
        }

        // Not in cache: fetch from network
        return fetch(request).then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            const copy = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return networkResponse;
        });
      })
    );
    return;
  }

  // 3. TTS Audio Generation Requests: Allow full network streaming without short timeout
  if (url.pathname.startsWith('/api/tts/')) {
    event.respondWith(
      fetch(request).catch(() => {
        return new Response(
          JSON.stringify({ error: 'offline', offline: true, message: 'TTS server unreachable' }),
          { status: 503, headers: { 'Content-Type': 'application/json' } }
        );
      })
    );
    return;
  }

  // 4. General API requests: fast response or offline fallback
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      (async () => {
        if (!navigator.onLine) {
          return new Response(
            JSON.stringify({ error: 'offline', offline: true, message: 'Device is offline' }),
            { status: 503, headers: { 'Content-Type': 'application/json' } }
          );
        }

        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 2000);
          const res = await fetch(request, { signal: controller.signal });
          clearTimeout(timer);
          return res;
        } catch {
          return new Response(
            JSON.stringify({ error: 'offline', offline: true, message: 'Device is offline' }),
            { status: 503, headers: { 'Content-Type': 'application/json' } }
          );
        }
      })()
    );
    return;
  }

  // Default: Network with Cache Fallback
  event.respondWith(
    fetch(request).catch(() => caches.match(request))
  );
});
