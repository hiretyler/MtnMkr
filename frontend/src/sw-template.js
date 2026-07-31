/* MtnMkr service worker.
 *
 * Not processed by Vite - the build plugin in vite.config.ts copies this file
 * to dist/sw.js, substituting the two placeholder tokens below with the build
 * hash and the real hashed asset names. Written as a plain classic script so
 * it needs no compile step of its own. (Do not repeat those token names
 * anywhere above their real use: substitution is textual.)
 *
 * Two caches, deliberately with different lifetimes:
 *
 *   shell (versioned)  the app itself. Replaced wholesale on every deploy.
 *   data   (stable)    terrain payloads. Survives app updates, because
 *                      evicting a few hundred MB of DEMs that a user
 *                      deliberately cached - just because the CSS changed -
 *                      would be the single most destructive thing this file
 *                      could do. Only an explicit "clear cached terrain"
 *                      wipes it.
 */

const VERSION = '__CACHE_VERSION__'
const SHELL_FILES = __PRECACHE_MANIFEST__
// Empty for same-origin; an absolute origin when the API is hosted apart from
// the static frontend. Terrain from that origin still has to be cacheable, so
// it is matched explicitly rather than by the same-origin check below.
const API_BASE = '__API_BASE__'
const API_ORIGIN = API_BASE ? new URL(API_BASE, self.location.href).origin : self.location.origin

// Where pre-baked tiles are published, if anywhere.
const PREBAKE_BASE = '__PREBAKE_BASE__'
const PREBAKE_ORIGIN = PREBAKE_BASE ? new URL(PREBAKE_BASE, self.location.href).origin : ''

// With no backend the browser fetches elevation and imagery from USGS itself,
// so these have to be cacheable too - otherwise the offline story would work
// only for deployments that happen to have a proxy in front. Both send
// Access-Control-Allow-Origin: *, so the responses are real (not opaque) and
// can be stored and replayed.
const USGS_ORIGINS = [
  'https://elevation.nationalmap.gov',
  'https://basemap.nationalmap.gov',
]

const SHELL_CACHE = 'mtnmkr-shell-' + VERSION
const DATA_CACHE = 'mtnmkr-data-v1'

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) =>
      // Individually, so one 404 cannot fail the whole install
      Promise.all(
        SHELL_FILES.map((url) =>
          cache.add(new Request(url, { cache: 'reload' })).catch(() => undefined),
        ),
      ),
    ),
  )
  // No skipWaiting: a field session must never have its JS swapped out from
  // under it mid-use. The page offers a reload when an update is ready.
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Sweep every shell but this one. Deployed back to back, an older
      // worker can be replaced before its own activate ran, leaving its cache
      // behind - so sweep on every activation rather than assuming each
      // version cleaned up after itself.
      const names = await caches.keys()
      await Promise.all(
        names
          .filter((n) => n.startsWith('mtnmkr-shell-') && n !== SHELL_CACHE)
          .map((n) => caches.delete(n)),
      )
      await self.clients.claim()
    })(),
  )
})

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting()
  if (event.data?.type === 'CLEAR_TERRAIN') {
    event.waitUntil(
      caches.delete(DATA_CACHE).then(() => {
        event.source?.postMessage({ type: 'TERRAIN_CLEARED' })
      }),
    )
  }
})

/** Immutable by construction: area ids are a hash of the request parameters,
 *  so a given URL's bytes never change. Safe to serve from cache forever. */
function isTerrainData(url) {
  if (url.origin === API_ORIGIN) {
    if (/\/api\/area\/[^/]+\/(heights|texture|layers)/.test(url.pathname)) return true
    if (/\/api\/area\/[^/]+$/.test(url.pathname)) return true
  }
  // A 3DEP or basemap export is fully determined by its query string, so the
  // request URL is a sound cache key even though it is not a tidy path.
  if (USGS_ORIGINS.includes(url.origin)) return true
  // Pre-baked tiles are content-addressed and immutable.
  if (PREBAKE_ORIGIN && url.origin === PREBAKE_ORIGIN) return true
  // Only fetched when the user exports; runtime-cached so exports keep
  // working offline once they have been used at least once.
  return url.origin === self.location.origin && url.pathname.endsWith('/standalone-viewer.js')
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName)
  const hit = await cache.match(request)
  if (hit) return hit
  const res = await fetch(request)
  if (res.ok) cache.put(request, res.clone()).catch(() => undefined)
  return res
}

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return // area builds and uploads need the network

  const url = new URL(request.url)
  if (
    url.origin !== self.location.origin &&
    url.origin !== API_ORIGIN &&
    url.origin !== PREBAKE_ORIGIN &&
    !USGS_ORIGINS.includes(url.origin)
  ) {
    return
  }

  // Navigations: network first so a deploy is picked up, falling back to the
  // cached shell so a reload with no signal still boots.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(async () => {
        const cache = await caches.open(SHELL_CACHE)
        return (
          (await cache.match(request)) ??
          (await cache.match('index.html')) ??
          (await cache.match('/')) ??
          new Response('Offline and no cached copy of the app.', {
            status: 503,
            headers: { 'Content-Type': 'text/plain' },
          })
        )
      }),
    )
    return
  }

  if (isTerrainData(url)) {
    event.respondWith(cacheFirst(request, DATA_CACHE))
    return
  }

  // Search, capabilities, health: live data, no value stale.
  if (url.origin === API_ORIGIN && url.pathname.includes('/api/')) return

  // Hashed build assets: content-addressed, cache-first is safe.
  event.respondWith(
    caches.match(request).then((hit) => hit ?? fetch(request)),
  )
})
