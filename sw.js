// Кэш приложения для работы без сети. Меняй VERSION при обновлении файлов.
const VERSION = 'efir-0.11.2';
const SHELL = ['./', 'index.html', 'app.js', 'fx.js', 'stretch.js', 'dsp.js', 'reaper.js', 'manifest.webmanifest', 'icon-180.png', 'icon-192.png', 'icon-512.png'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  const own = u.origin === location.origin;
  const cdn = /fonts\.(googleapis|gstatic)\.com|cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net/.test(u.host);
  if (!own && !cdn) return;
  // своё — сначала сеть (чтобы обновления приходили), потом кэш; шрифты и кодировщик — из кэша
  e.respondWith(own
    ? fetch(e.request).then((r) => { const c = r.clone(); caches.open(VERSION).then((k) => k.put(e.request, c)); return r; }).catch(() => caches.match(e.request, { ignoreSearch: true }))
    : caches.match(e.request).then((m) => m || fetch(e.request).then((r) => { const c = r.clone(); caches.open(VERSION).then((k) => k.put(e.request, c)); return r; })));
});
