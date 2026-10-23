/* ==========================================================================
   sw.js — lets Ledgerline be installed as a Mac app and open offline.
   --------------------------------------------------------------------------
   Three rules, all about never showing something stale without saying so:

   1. APP FILES ARE NETWORK-FIRST.
      Every launch asks GitHub Pages first (a cheap "has it changed?" check)
      and only falls back to the saved copy when there is no network. After
      you upload new files, the Dock app runs them on its next launch — the
      same as a browser tab. (Cache-first would keep running old code with
      no sign it was out of date.)

   2. MARKET DATA, SYNC AND SHARE LINKS ARE NEVER TOUCHED.
      Anything that isn't one of this site's own files — Yahoo, Dexscreener,
      CoinGecko, your relay, your sync Worker — passes straight through.
      The app keeps its own price cache that knows how old each price is;
      caching here would hand back old prices looking fresh.

   3. version.json IS NEVER CACHED.
      It is how the app notices an update ("Update available — Reload"), so
      it must always come from the network.

   VERSION must match APP_VERSION in js/config.js (bump all of them together:
   config.js, version.json, the ?v= in index.html, and here).
   ========================================================================== */

const VERSION = '2026.10.23-1';
const CACHE = 'ledgerline-' + VERSION;
const V = '?v=' + VERSION;

/* Everything needed to open with no network — the same URLs index.html asks for. */
const SHELL = [
  './',
  'manifest.webmanifest',
  'css/app.css' + V,
  'js/config.js' + V, 'js/util.js' + V, 'js/store.js' + V, 'js/portfolio.js' + V,
  'js/providers.js' + V, 'js/market.js' + V, 'js/history.js' + V, 'js/charts.js' + V,
  'js/ui.js' + V, 'js/views.js' + V, 'js/transactions.js' + V, 'js/settings.js' + V,
  'js/cash.js' + V, 'js/pie.js' + V, 'js/sync.js' + V, 'js/viewer.js' + V,
  'js/modal.js' + V, 'js/pwa.js' + V, 'js/app.js' + V,
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png', 'icons/favicon-32.png'
];

/* A launch on a very slow connection: after this long, open the saved copy of
   the SAME version rather than leave a blank window. */
const SLOW_MS = 5000;

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      // `reload` skips the HTTP cache, so the offline copy is the real current file
      .then(cache => cache.addAll(SHELL.map(u => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k.indexOf('ledgerline-') === 0 && k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Rule 2: not this site's file (prices, relay, sync, share links, fonts) — hands off.
  if (url.origin !== self.location.origin) return;
  // Only files inside this app's folder: other GitHub Pages projects share the origin.
  const scope = new URL(self.registration.scope);
  if (url.pathname.indexOf(scope.pathname) !== 0) return;
  // Rule 3.
  if (/\/version\.json$/.test(url.pathname)) return;

  event.respondWith(networkFirst(req, event));
});

/* Every page load is the same single page, whatever its ?view= / ?v= / #route,
   so it is stored once under './'. */
const keyFor = req => req.mode === 'navigate' ? './' : req;

function networkFirst(req, event) {
  // A navigation request can't be copied with new options, so rebuild it from its URL.
  // `no-cache` revalidates with the server (a 304 when nothing changed).
  const fresh = req.mode === 'navigate'
    ? new Request(req.url, { cache: 'no-cache', credentials: 'same-origin' })
    : new Request(req, { cache: 'no-cache' });

  const network = fetch(fresh).then(res => {
    if (res && res.ok && res.type === 'basic') {
      const copy = res.clone();
      event.waitUntil(caches.open(CACHE).then(c => c.put(keyFor(req), copy)));
    }
    return res;
  });

  // Slow network: an exact saved copy (same ?v=) may stand in; never a different version.
  const slow = new Promise(resolve => setTimeout(resolve, SLOW_MS))
    .then(() => caches.match(keyFor(req)))
    .then(hit => hit || network);

  return Promise.race([network, slow]).catch(() =>
    // Offline: the saved copy — exact first, then any version of the same file.
    caches.match(keyFor(req))
      .then(hit => hit || caches.match(keyFor(req), { ignoreSearch: true }))
      .then(hit => hit || (req.mode === 'navigate' ? caches.match('./', { ignoreSearch: true }) : null))
      .then(hit => hit || new Response('', { status: 504, statusText: 'Offline and not saved' }))
  );
}
