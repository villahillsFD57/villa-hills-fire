const CACHE = "vhfd-v7";
const OFFLINE_PAGES = new Set(["/", "/about", "/apparatus", "/members", "/join", "/fundraising", "/raffle"]);
const STATIC = ["/manifest.json", "/icon-192.png", "/icon-512.png"];

self.addEventListener("install", (event) => {
  // A single missing asset must not prevent a repaired worker from activating.
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => Promise.allSettled(STATIC.map((url) => cache.add(url))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key.startsWith("vhfd-") && key !== CACHE).map((key) => caches.delete(key)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;
  // Never intercept live data, authenticated pages, form pages, or Next RSC
  // responses. Query-string responses can have request-specific contents.
  if (url.search || /^\/(api|admin|auth|apply)(\/|$)/.test(url.pathname)
    || request.headers.has("authorization") || request.headers.has("rsc")) return;

  if (request.mode === "navigate" && OFFLINE_PAGES.has(url.pathname)) {
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        if (response.ok && response.type === "basic" && !response.redirected) {
          const copy = response.clone();
          event.waitUntil(caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => {}));
        }
        return response;
      } catch {
        const cached = await caches.match(request);
        return cached || new Response("You are offline. Reconnect to view the Villa Hills Fire Department website.", {
          status: 503,
          headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
        });
      }
    })());
    return;
  }

  // Next's build-hashed assets are immutable. Other resources remain network
  // controlled so replacing an image or script does not require a cache bump.
  if (url.pathname.startsWith("/_next/static/")) {
    event.respondWith((async () => {
      const cached = await caches.match(request);
      if (cached) return cached;
      try {
        const response = await fetch(request);
        if (response.ok && response.type === "basic") {
          const copy = response.clone();
          event.waitUntil(caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => {}));
        }
        return response;
      } catch {
        return Response.error();
      }
    })());
  }
});
