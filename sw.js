// ELPP service worker: always tries the network first, so a re-uploaded index.html reaches the phone at the next open. Cache is only the offline fallback.
const V = 'elpp-shell';
self.addEventListener('install', e => { self.skipWaiting(); e.waitUntil(caches.open(V).then(c => c.addAll(['./', './manifest.webmanifest', './icon-192.png', './icon-512.png'])).catch(() => {})); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(k => Promise.all(k.filter(x => x !== V).map(x => caches.delete(x)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const r = e.request; if (r.method !== 'GET') return; const u = new URL(r.url); if (u.origin !== location.origin) return;
  e.respondWith(fetch(r, { cache: 'no-store' }).then(res => { if (res.ok){ const cp = res.clone(); caches.open(V).then(c => c.put(r, cp)); } return res; }).catch(() => caches.match(r).then(m => m || caches.match('./'))));
});
