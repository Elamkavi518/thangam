// Minimal service worker: makes the app installable and lets the page shell open offline.
// It NEVER caches API calls (they are cross-origin), so prices/stores are always fetched live.
const CACHE = 'goldwise-shell-v2';
const SHELL = ['/', '/index.html', '/styles.css', '/app.js', '/core.js', '/i18n.js', '/staff.js', '/manifest.webmanifest', '/icon-192.png'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL))); self.skipWaiting(); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname === '/config.js') return; // API + config always live
  e.respondWith(fetch(e.request).then((res) => { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return res; }).catch(() => caches.match(e.request)));
});
