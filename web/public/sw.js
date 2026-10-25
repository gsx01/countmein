// Carpool service worker (plain JS, root scope). Two jobs:
//   1. App-shell caching so the app is installable and launches offline.
//   2. Web Push: show a notification from the payload and focus/open the app.
// Push payloads are JSON: { title, body, url, tag }. Pushes for one trip share a
// tag (trip-<id>) so a newer one replaces the older in the tray instead of
// stacking, without re-alerting (renotify off).

const SHELL_CACHE = 'countmein-shell-v3';
const SHELL_URL = '/';
const ASSET_PREFIX = '/assets/';

// Stores the shell HTML plus the hashed bundle it references, and drops bundles
// from older builds. Assets are served `max-age=0, must-revalidate`, so without
// this an offline launch gets the HTML but no JS.
async function cacheShell(cache, response) {
  const html = await response.clone().text();
  await cache.put(SHELL_URL, response);
  const wanted = new Set(html.match(/\/assets\/[^"'\s)]+/g) || []);
  await cache.addAll([...wanted]);
  for (const req of await cache.keys()) {
    const path = new URL(req.url).pathname;
    if (path.startsWith(ASSET_PREFIX) && !wanted.has(path)) await cache.delete(req);
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      await cacheShell(cache, await fetch(SHELL_URL));
    })().catch(() => {}),
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== SHELL_CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

// Network-first for page navigations, falling back to the cached shell offline.
// Hashed assets are cache-first (a hash never changes content). Everything else
// (API calls, icons) goes straight to the network.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method === 'GET' && url.origin === self.location.origin && url.pathname.startsWith(ASSET_PREFIX)) {
    event.respondWith(
      (async () => {
        const cached = await caches.match(req, { ignoreSearch: true });
        return cached || fetch(req);
      })(),
    );
    return;
  }
  if (req.mode !== 'navigate') return;
  event.respondWith(
    (async () => {
      try {
        const fresh = await fetch(req);
        // Only the app page may become the offline shell: a navigation straight
        // to /api/state would otherwise replace it with JSON and drop the bundle.
        const isShell =
          !url.pathname.startsWith('/api/') &&
          (fresh.headers.get('content-type') || '').includes('text/html');
        if (fresh.ok && isShell) {
          const cache = await caches.open(SHELL_CACHE);
          event.waitUntil(cacheShell(cache, fresh.clone()).catch(() => {}));
        }
        return fresh;
      } catch (_e) {
        const cached = await caches.match(SHELL_URL);
        return cached || Response.error();
      }
    })(),
  );
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (_e) {
    data = {};
  }
  const title = data.title || 'Count me in';
  const options = {
    body: data.body || '',
    icon: '/favicon.png',
    badge: '/favicon.png',
    tag: data.tag,
    renotify: false,
    data: { url: data.url || '/' },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of all) {
        if ('focus' in client) {
          if ('navigate' in client) {
            try {
              await client.navigate(url);
            } catch (_e) {
              // cross-origin or detached; fall back to focus alone
            }
          }
          return client.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })(),
  );
});
