const CACHE_NAME = "maquis-manager-static-v11";
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

  // Ne pas mettre index.html / *.js / *.css en cache runtime : évite une ancienne version après déploiement.
  event.respondWith(fetch(event.request).catch(() => caches.match(event.request)));
});
