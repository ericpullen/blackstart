/* sw.js — offline cache for Blackstart.
 *
 * This app exists to be usable when the power is out, which often means no
 * home Wi-Fi and a congested cell network. Everything it needs must already
 * be on the device. That makes this file load-bearing:
 *
 *   1. BUMP `CACHE` on every deploy. The strategy is cache-first, so an
 *      installed app will never refetch anything until the cache name changes.
 *   2. ADD every new file to `ASSETS`. Anything not listed is not available
 *      offline.
 *   3. Every path in `ASSETS` must actually exist. `cache.addAll()` rejects
 *      atomically, so one bad path means the worker never installs and you
 *      lose ALL offline support. `npm run validate` checks this.
 */
var CACHE = "blackstart-v4";
var ASSETS = [
  "./",
  "index.html",
  "install.html",
  "manifest.webmanifest",
  "src/model.js",
  "src/app.js",
  "data/montfort.json",
  "assets/icon.svg",
  "assets/icon-192.png",
  "assets/icon-512.png",
  "assets/apple-touch-icon.png",
  "images/panel-a/step1-unplug-anker.jpg"
];

self.addEventListener("install", function (e) {
  e.waitUntil(
    caches.open(CACHE)
      .then(function (c) { return c.addAll(ASSETS); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        if (k !== CACHE) return caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("fetch", function (e) {
  if (e.request.method !== "GET") return;

  var url = new URL(e.request.url);
  var isData = url.pathname.indexOf("/data/") >= 0;

  /* Home data is the one thing you edit often, so prefer the network and fall
   * back to cache. Everything else is cache-first for speed and reliability. */
  if (isData) {
    e.respondWith(
      fetch(e.request).then(function (res) {
        var clone = res.clone();
        caches.open(CACHE).then(function (c) {
          try { c.put(e.request, clone); } catch (err) {}
        });
        return res;
      }).catch(function () {
        return caches.match(e.request);
      })
    );
    return;
  }

  e.respondWith(
    caches.match(e.request).then(function (hit) {
      return hit || fetch(e.request).then(function (res) {
        var clone = res.clone();
        caches.open(CACHE).then(function (c) {
          try { c.put(e.request, clone); } catch (err) {}
        });
        return res;
      }).catch(function () { return hit; });
    })
  );
});
