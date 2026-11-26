// BYoB Service Worker v55
// High-performance offline caching with instant WebKit/Safari PWA launch
//
// ASSET_VERSION is the address every cached stylesheet and script is asked for by, here and in
// index.html. Keep the two the same. Bump it whenever one of those files changes: the installed
// app serves /css/ and /js/ from this cache before the network, so a changed file living at an
// unchanged address keeps being read from the old copy. (2026-11-24: a fixed tts.js sat unused
// on the phone for exactly this reason, and the phone kept saying the PC voice was unreachable.)
// Forgetting the bump is no longer fatal - see the revalidate below - but it costs a reload.
const ASSET_VERSION = '57.0';
const CACHE_NAME = 'byob-v' + ASSET_VERSION;

const PRECACHE_ASSETS = [
  '/',
  '/index.html',
  '/css/brutalist.css?v=' + ASSET_VERSION,
  '/css/refresh.css?v=' + ASSET_VERSION,
  '/js/app.js?v=' + ASSET_VERSION,
  '/js/reader.js?v=' + ASSET_VERSION,
  '/js/tank.js?v=' + ASSET_VERSION,
  '/js/tts.js?v=' + ASSET_VERSION,
  '/js/storage.js?v=' + ASSET_VERSION,
  '/js/sync.js?v=' + ASSET_VERSION,
  '/js/autoscroll.js?v=' + ASSET_VERSION,
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png'
];

// Tapping a read-aloud notification brings the app back to the front.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) { if ('focus' in c) return c.focus(); }
    return self.clients.openWindow ? self.clients.openWindow('/') : null;
  }));
});

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

// Re-reads one cached stylesheet or script from the network, ignoring the browser's own cache, and
// only disturbs the page when the bytes really changed: then the running app is told, so it reloads
// into the new code instead of waiting for someone to notice.
async function revalidateAsset(request, cachedClone) {
  try {
    const fresh = await fetch(request, { cache: 'reload' });
    if (!fresh || fresh.status !== 200) return;
    const copy = fresh.clone();
    const [oldText, newText] = await Promise.all([cachedClone.text(), fresh.text()]);
    if (oldText === newText) return;
    const cache = await caches.open(CACHE_NAME);
    await cache.put(request, copy);
    const clients = await self.clients.matchAll({ type: 'window' });
    for (const client of clients) {
      client.postMessage({ type: 'ASSET_UPDATED', url: request.url });
    }
  } catch (err) {
    // Offline or a dead zone: keep the cached copy, try again next launch.
  }
}

// The app shell we fall back to when the network is slow. Both addresses are pre-cached and a
// navigation can arrive as either, so look under both.
// This build's own cache first: a copy left behind in an older cache is by definition the older
// page, and caches.match() searches every cache in the order they were made, so it would win.
async function cachedShell() {
  const cache = await caches.open(CACHE_NAME);
  return (await cache.match('/index.html')) || (await cache.match('/'))
    || (await caches.match('/index.html')) || (await caches.match('/'));
}

// The slow answer to a navigation we already served from the cache. If the page really changed,
// store it and tell the running app, which reloads into the new code. Reloading is safe to repeat:
// the next launch compares equal bytes and says nothing.
async function reviseShell(networkPromise, cachedClone) {
  try {
    const fresh = await networkPromise;
    if (!fresh || fresh.status !== 200) return;
    // Clone once and read the original: cloning a response whose body has been read is not allowed.
    const toCache = fresh.clone();
    const [freshText, oldText] = await Promise.all([fresh.text(), cachedClone.text()]);
    if (freshText === oldText) return;
    const cache = await caches.open(CACHE_NAME);
    await cache.put('/index.html', toCache);
    const clients = await self.clients.matchAll({ type: 'window' });
    for (const client of clients) {
      client.postMessage({ type: 'SHELL_UPDATED' });
    }
  } catch (err) {
    // Offline or a dead zone: keep the cached shell and try again next launch.
  }
}

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
          const cached = await cachedShell();
          if (cached) return cached;
        }

        // Online path: give the network 1500 ms so offline/dead-zone WebKit never stalls, then
        // serve the cached shell - but the request is NOT cancelled. It used to be aborted, and
        // that is how a phone could stay on last week's app for days: every launch that lost the
        // race served the old page and threw away the only chance to learn about the new one, and
        // the old page is what asks for the old /js/ files. Now the slow answer still arrives,
        // still replaces the cached shell, and the running page is told to reload into it
        // (2026-11-25: Rocco's phone kept saying the PC voice was unreachable for this reason).
        const networkPromise = fetch(request, { cache: 'reload' });
        networkPromise.catch(() => {});  // handled below; never an unhandled rejection
        let fresh = null;
        try {
          fresh = await Promise.race([
            networkPromise,
            new Promise((resolve) => setTimeout(() => resolve(null), 1500))
          ]);
        } catch (err) {
          fresh = null;
        }

        if (fresh && fresh.status === 200) {
          const copy = fresh.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put('/index.html', copy));
          return fresh;
        }

        const cached = await cachedShell();
        if (cached) {
          event.waitUntil(reviseShell(networkPromise, cached.clone()));
          return cached;
        }
        // Nothing cached at all: the network is the only answer, however long it takes.
        return networkPromise;
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
            // Background revalidate if online. `cache: 'reload'` is what makes this worth doing:
            // the host sends these files with a day-long browser cache, so a plain fetch here is
            // answered by that cache with the very copy we already have, and a new file under the
            // same address could not arrive for 24 hours no matter how often the app was restarted.
            // Going straight to the network means a missed ASSET_VERSION bump costs one reload
            // instead of a day of the old app (2026-11-24).
            revalidateAsset(request, cachedResponse.clone());
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

  // 4. General API requests: generous timeout so a cold-starting free host is not mistaken for offline
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
          const timer = setTimeout(() => controller.abort(), 20000);
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
