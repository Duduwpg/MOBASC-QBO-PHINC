// Offline support: network first (so updates arrive), cache as the fallback when offline.
const CACHE = "inv-count-2026-10-26.4";
const SHELL = [
  "./", "index.html", "style.css", "manifest.webmanifest", "icon.svg",
  "js/app.js", "js/codes.js", "js/csv.js", "js/sheet.js",
  "vendor/barcode-detector-ponyfill.js", "vendor/zxing_reader.wasm",
];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 4000));
      const res = await Promise.race([fetch(e.request), timeout]);
      if (res.ok) cache.put(e.request, res.clone());
      return res;
    } catch {
      return (await cache.match(e.request, { ignoreSearch: true })) || Response.error();
    }
  })());
});
