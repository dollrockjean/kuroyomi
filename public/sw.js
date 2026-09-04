// KuroYomi Service Worker
// Enables 100% offline reading for mobile devices (iOS Safari / Android Chrome)
const CACHE_NAME = 'kuroyomi-v2';

const PRECACHE_ASSETS = [
  '/',
  '/index.html',
  '/css/brutalist.css',
  '/js/app.js',
  '/js/reader.js',
  '/js/tts.js',
  '/js/storage.js',
  '/js/sync.js',
  '/js/autoscroll.js',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png'
];

// Install: pre-cache application shell
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_ASSETS))
      .then(() => self.skipWaiting())
      .catch((err) => console.warn('[SW] Pre-cache warning:', err))
  );
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

  // Ignore non-GET requests (e.g. POST /api/progress handled directly by client)
  if (request.method !== 'GET') {
    return;
  }

  // 1. Navigation / HTML requests: Network-first with Cache fallback
  if (request.mode === 'navigate' || request.destination === 'document') {
    event.respondWith(
      fetch(request)
        .then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            const copy = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return networkResponse;
        })
        .catch(() => {
          return caches.match('/index.html').then((cached) => cached || caches.match('/'));
        })
    );
    return;
  }

  // 2. Static Assets (CSS, JS, manifest, icons): Cache-first with Stale-While-Revalidate
  const isStaticAsset = (
    url.pathname.startsWith('/css/') ||
    url.pathname.startsWith('/js/') ||
    url.pathname.startsWith('/icons/') ||
    url.pathname === '/manifest.json'
  );

  if (isStaticAsset) {
    event.respondWith(
      caches.match(request).then((cachedResponse) => {
        const fetchPromise = fetch(request).then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            const copy = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return networkResponse;
        }).catch(() => {
          // Network failed, cache served if available
        });

        return cachedResponse || fetchPromise;
      })
    );
    return;
  }

  // 3. API requests
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(request).catch(() => {
        // Return 503 JSON so client fetch catches network disconnect gracefully
        return new Response(
          JSON.stringify({ error: 'offline', offline: true, message: 'Device is offline' }),
          {
            status: 503,
            headers: { 'Content-Type': 'application/json' }
          }
        );
      })
    );
    return;
  }

  // Default: Network with Cache Fallback
  event.respondWith(
    fetch(request).catch(() => caches.match(request))
  );
});
