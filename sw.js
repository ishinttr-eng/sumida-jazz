// すみだジャズナビ Service Worker
// UI・見た目・ロジックを変更したら必ず VERSION を上げること
const VERSION = "v17";
const CACHE_NAME = `sjz-${VERSION}`;

const APP_SHELL = [
  "./",
  "index.html",
  "manifest.webmanifest",
  "icon.svg",
  "css/style.css",
  "js/app.js",
  "js/store.js",
  "js/util.js",
  "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css",
  "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      await Promise.all(
        APP_SHELL.map((url) =>
          fetch(url, { cache: "reload" })
            .then((res) => (res.ok ? cache.put(url, res) : null))
            .catch(() => null)
        )
      );
      self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)));
      self.clients.claim();
    })()
  );
});

function isDataRequest(url) {
  return url.pathname.includes("/data/");
}
function isTileRequest(url) {
  return /tile\.openstreetmap\.org|\{s\}\.tile/.test(url.hostname) || url.hostname.endsWith("tile.openstreetmap.org");
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  if (isTileRequest(url)) return; // 地図タイルはキャッシュしない（容量対策）

  if (isDataRequest(url)) {
    // ネットワーク優先、失敗時のみキャッシュにフォールバック
    event.respondWith(
      (async () => {
        try {
          const res = await fetch(req);
          const cache = await caches.open(CACHE_NAME);
          cache.put(req, res.clone());
          return res;
        } catch {
          const cached = await caches.match(req);
          if (cached) return cached;
          throw new Error("offline and no cache");
        }
      })()
    );
    return;
  }

  // アプリシェル・地図ライブラリ等はキャッシュ優先
  event.respondWith(
    (async () => {
      const cached = await caches.match(req);
      if (cached) return cached;
      try {
        const res = await fetch(req);
        if (res.ok && (url.origin === self.location.origin || APP_SHELL.includes(req.url))) {
          const cache = await caches.open(CACHE_NAME);
          cache.put(req, res.clone());
        }
        return res;
      } catch {
        return cached || Response.error();
      }
    })()
  );
});
