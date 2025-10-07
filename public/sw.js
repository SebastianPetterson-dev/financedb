// Very small cache-first for static assets + the page shell.
// (Your API calls still go online — which is what you want for Notion uploads.)

const CACHE = "receipts-shell-v1";
const ASSETS = [
  "/",                // page shell
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;

  // Only cache GET requests; always bypass for your Notion API route.
  const isAPI = request.url.includes("/api/notion-receipt");
  if (request.method !== "GET" || isAPI) return;

  event.respondWith(
    caches.match(request).then((cached) =>
      cached ||
      fetch(request).then((res) => {
        // Optionally cache same-origin GET responses
        try {
          const copy = res.clone();
          const url = new URL(request.url);
          if (url.origin === self.location.origin) {
            caches.open(CACHE).then((c) => c.put(request, copy));
          }
        } catch {}
        return res;
      })
    )
  );
});
