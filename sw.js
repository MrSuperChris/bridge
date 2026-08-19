/* Bridge service worker — app shell only.

   Deliberately narrow: it caches the shell so the app opens instantly and
   survives a dead connection, and it NEVER touches api.ticktick.com. A cached
   board would be the worst possible failure here — a console showing yesterday's
   queue as though it were live is exactly the stale-health-indicator problem the
   ecosystem doc calls out (G8). Board data is always fetched from the network. */

const CACHE = 'bridge-v1';
const SHELL = ['./', './index.html', './style.css', './app.js', './manifest.webmanifest'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;   // never intercept the API
  if (e.request.method !== 'GET') return;

  /* Network-first for the shell so a deploy lands without a hard reload,
     falling back to cache when offline. */
  e.respondWith(
    fetch(e.request)
      .then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(e.request).then(r => r || caches.match('./index.html')))
  );
});
