const CACHE_NAME = "maquis-manager-static-v12";
const STATIC_ASSETS = ["./manifest.json", "./icon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const requestUrl = new URL(event.request.url);
  if (requestUrl.pathname.startsWith("/api/") || event.request.method !== "GET") return;

  // Cache-first uniquement pour manifest.json et icon.svg (petits assets immuables).
  // HTML / JS / CSS : pas d'interception — le navigateur gère nativement.
  // Évite la page blanche au démarrage serveur (le catch() retournait undefined).
  const isStaticAsset = STATIC_ASSETS.some((a) => requestUrl.pathname.endsWith(a.replace("./", "")));
  if (!isStaticAsset) return;

  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request)),
  );
});
