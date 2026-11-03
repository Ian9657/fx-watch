// Offline copy of the app. Online, everything comes from the network as
// usual and a copy is kept; offline, the copy is served, so the app still
// opens and shows the last prices. Copies of API answers are marked with an
// X-Offline header (when they were saved) so the page can say they're old.
// Renamed when what's kept changes shape; older copies are deleted on activate.
const CACHE = 'fx-watch-2';
const SHELL = [
  '/', '/style.css', '/manifest.webmanifest', '/icon-180.png',
  '/js/app.js', '/js/shared.js', '/js/dial.js', '/js/tape.js', '/js/back.js', '/js/sheet.js', '/js/demo.js', '/js/lock.js', '/js/spring.js',
  '/fonts/cinzel-700.woff2', '/fonts/cormorant-garamond.woff2', '/fonts/playfair-display-700.woff2', '/fonts/special-elite.woff2',
];

self.addEventListener('install', event => {
  // Straight from the server, not the browser's cache, which may be stale.
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL.map(url => new Request(url, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => event.waitUntil(
  caches.keys()
    .then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))
    .then(() => self.clients.claim()),
));

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== location.origin) return;
  event.respondWith(fromNetwork(event.request, url.pathname.startsWith('/api/')));
});

async function fromNetwork(request, isApi) {
  const cache = await caches.open(CACHE);
  try {
    // Always check with the server (a 304 is cheap), so a stale copy in the
    // browser's own cache can't be served after a deploy. A page load must
    // be fetched as it came.
    const response = await fetch(request.mode === 'navigate' ? request : new Request(request, { cache: 'no-cache' }));
    if (response.ok) {
      const copy = response.clone();
      if (isApi) {
        // Note when it was saved, for the page to show if it's used offline.
        const headers = new Headers(copy.headers);
        headers.set('X-Offline', String(Date.now()));
        await cache.put(request, new Response(await copy.blob(), { status: copy.status, headers }));
      } else {
        await cache.put(request, copy);
      }
    }
    return response;
  } catch (err) {
    // Ignore the query: /api/rates?since= changes every day.
    const saved = await cache.match(request, { ignoreSearch: true });
    if (saved) return saved;
    throw err;
  }
}
