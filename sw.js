/* ELPP Scanner: network first, so the app always updates itself; cached copy only when offline */
const C = 'elpp-v2';
self.addEventListener('install', e => { self.skipWaiting(); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== C).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const r = e.request, u = new URL(r.url);
  if (r.method !== 'GET' || u.origin !== location.origin) return;
  e.respondWith(fetch(r, {cache:'no-store'}).then(res => { const cp = res.clone(); caches.open(C).then(c => c.put(r, cp)).catch(() => {}); return res; }).catch(() => caches.match(r).then(m => m || caches.match('./'))));
});
