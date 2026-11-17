// RevealNotes service worker: offline app shell + Android share target.
const CACHE = "revealnotes-__VERSION__";
const SHARE_CACHE = "revealnotes-share";
const SHELL = ["./", "./index.html", "./manifest.webmanifest", "./icon.svg", "./icon-192.png", "./player.js", "./player.css"];

self.addEventListener("install", (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    (async () => {
      for (const k of await caches.keys()) if (k !== CACHE && k !== SHARE_CACHE) await caches.delete(k);
      await self.clients.claim();
    })(),
  );
});

// The page reports the files it loaded before this worker took control, so they work offline too.
self.addEventListener("message", (e) => {
  const urls = e.data && e.data.cache;
  if (Array.isArray(urls)) e.waitUntil(caches.open(CACHE).then((c) => Promise.all(urls.map((u) => c.add(u).catch(() => {})))));
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  if (req.method === "POST" && url.pathname.endsWith("/share-target")) {
    e.respondWith(
      (async () => {
        const form = await req.formData();
        const cache = await caches.open(SHARE_CACHE);
        for (const f of form.getAll("files")) {
          if (f instanceof File) await cache.put(new Request(`./shared/${encodeURIComponent(f.name)}`), new Response(f));
        }
        return Response.redirect("./?shared=1", 303);
      })(),
    );
    return;
  }
  if (req.method !== "GET") return;

  if (req.mode === "navigate") {
    // Network first so a new deploy is picked up; the cached shell when offline.
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
          return res;
        })
        .catch(async () => (await caches.match(req)) || (await caches.match("./index.html")) || Response.error()),
    );
    return;
  }

  // Build assets have content-hashed names, so cache-first is safe.
  e.respondWith(
    caches.match(req).then(
      (hit) =>
        hit ||
        fetch(req).then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        }),
    ),
  );
});
