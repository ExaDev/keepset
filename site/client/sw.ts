/* The service worker. On install it precaches the shell and listing pages named in precache.json, under a cache named for the build's version; on activate it drops every other version's cache. Requests are answered from the cache when present, otherwise from the network, and a successful same-origin response is cached, so every page visited once stays readable offline. */

// A module, so this declaration narrows the global `self` to the service worker scope for this file alone.
export {};
declare const self: ServiceWorkerGlobalScope;

interface Precache {
  readonly version: string;
  readonly urls: readonly string[];
}

function isPrecache(value: unknown): value is Precache {
  return typeof value === "object" && value !== null && "version" in value && typeof value.version === "string" && "urls" in value && Array.isArray(value.urls) && value.urls.every((url) => typeof url === "string");
}

async function precache(): Promise<Precache> {
  const response = await fetch("precache.json", { cache: "no-store" });
  const parsed: unknown = await response.json();
  if (!isPrecache(parsed)) {
    throw new Error("precache.json is not a precache manifest");
  }

  return parsed;
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    precache().then(async ({ version, urls }) => {
      const cache = await caches.open(version);
      await cache.addAll([...urls]);
      await self.skipWaiting();
    }),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    precache().then(async ({ version }) => {
      const names = await caches.keys();
      await Promise.all(names.filter((name) => name !== version).map(async (name) => caches.delete(name)));
      await self.clients.claim();
    }),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET" || new URL(request.url).origin !== self.location.origin) {
    return;
  }
  event.respondWith(
    (async () => {
      const cached = await caches.match(request);
      if (cached !== undefined) {
        return cached;
      }
      const response = await fetch(request);
      if (response.ok) {
        const { version } = await precache();
        await (await caches.open(version)).put(request, response.clone());
      }

      return response;
    })(),
  );
});
