// Service Worker — cache app shell pour fonctionnement hors ligne.
// Version incrémentée à chaque déploiement pour forcer le rechargement.
const CACHE_VERSION = "maquis-2026-06-04-v1";
const APP_SHELL = ["/", "/index.html", "/app-orders.js", "/styles.css"];

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(APP_SHELL)).catch(() => {}),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  // Appels API : réseau uniquement, pas de cache
  if (url.pathname.startsWith("/api/")) return;
  // App shell : réseau en priorité, cache en fallback
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request)),
  );
});
