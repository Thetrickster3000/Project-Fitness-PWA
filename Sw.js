/* sw.js — Overload service worker
 * Strategy: precache the entire app (shell + engine + exercise database)
 * at install so the app is 100% functional with zero connectivity.
 * Same-origin requests: cache-first. Google Fonts: stale-while-revalidate.
 * Bump VERSION to ship an update — old caches are purged on activate.
 */
const VERSION = "overload-v1.0.0";
const SHELL_CACHE = VERSION + "-shell";
const FONT_CACHE = "overload-fonts";

const PRECACHE = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./plan-generator.js",
  "./exercises.json",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-512-maskable.png",
];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then(cache => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== SHELL_CACHE && k !== FONT_CACHE).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);

  // App shell + data: cache-first (the gym has no internet; never block on network).
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(request, { ignoreSearch: true }).then(cached =>
        cached ??
        fetch(request).then(res => {
          const copy = res.clone();
          caches.open(SHELL_CACHE).then(c => c.put(request, copy));
          return res;
        }).catch(() => caches.match("./index.html"))
      )
    );
    return;
  }

  // Web fonts: serve cached immediately, refresh in the background when online.
  if (url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com") {
    event.respondWith(
      caches.open(FONT_CACHE).then(async cache => {
        const cached = await cache.match(request);
        const network = fetch(request)
          .then(res => { cache.put(request, res.clone()); return res; })
          .catch(() => cached);
        return cached ?? network;
      })
    );
  }
});