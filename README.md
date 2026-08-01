# MtnMkr

Build a 3D model of a mountain that is more accurate than Google Earth, then
drape your own trip data over it.

Google Earth terrain in the mountains is roughly 10-30 m resolution. Over most
US mountains, USGS 3DEP has 1 m lidar. MtnMkr fetches the best available 3DEP
elevation for the area you pick, builds a terrain mesh from it, and lets you
layer USGS topo sheets, NAIP satellite imagery, your own georeferenced rasters,
GPS tracks, geotagged photos, and trip notes on top.

**It runs with or without a backend.** Every service it reads from - the 3DEP
ImageServer and the National Map basemaps - sends
`Access-Control-Allow-Origin: *` on the image responses themselves, so the
browser can fetch elevation and imagery directly. Search runs against a
bundled index. The FastAPI app is therefore optional: useful in development
for its shared disk cache, and required only for user-uploaded GeoTIFFs. See
"Where terrain comes from" and "Deploying".

## What it does

- **Terrain**: pick a peak by name (or paste `lat, lon`), choose a radius and
  grid detail, and get a mesh built from USGS 3DEP - down to ~1 m lidar where
  available. Outside 3DEP coverage it falls back to ~30 m global tiles
  (Terrarium), which matches Google Earth rather than beating it.
- **Search**: a bundled US gazetteer - 191k terrain features (summits, ranges,
  passes, ridges, glaciers) from USGS GNIS, public domain, ~3 MB shipped with
  the app. No API key, no third-party service, no request budget. Regenerate
  with `backend/scripts/build_gnis_gazetteer.py`. A "Search worldwide" toggle
  falls back to komoot's public Photon service for peaks outside the US; it is
  off by default because that is a demo endpoint whose terms only cover light
  use (see `backend/app/search.py`). Point `MTNMKR_PHOTON_URL` at your own
  Photon instance to use it freely.
- **Colorado index**: one-click, filterable lists of all Colorado 14ers and
  13ers (14ers.com waypoint data, bundled as JSON - regenerate with
  `backend/scripts/gpx_to_peaks_json.py`).
- **Draped layers**: shaded relief, USGS topo, NAIP satellite, or any GeoTIFF
  you upload (scanned quads, drone orthos) - warped onto the terrain
  server-side. GeoTIFF upload is the one feature that needs a backend; the
  control hides itself when there is none.
- **Tracks**: GPX, KML, and KMZ (including Google Earth `gx:Track` and Google
  My Maps exports) draped onto the surface. Waypoints and placemarks import as
  notes.
- **Photos**: dropped photos are pinned where their EXIF GPS says they were
  taken; photos without GPS can be placed by clicking the terrain. Photos are
  positioned as geo-anchored pins in this version - see "Photogrammetry" below.
- **Notes**: click-to-place trip report annotations.
- **Projects**: export/import everything (area, layers, overlays, photos) as a
  single JSON file. The current area is also encoded in the URL hash.
- **Share as a web page**: "Export page" builds one self-contained `.html` file -
  terrain, the texture layers you pick, tracks, photos, and notes all embedded -
  that opens with no server and no network in any browser, straight from
  `file://`. The viewer inside is the same 3D engine with mobile-first chrome:
  layer switcher, relief slider, compass, tap-to-measure coordinates/elevation,
  and tappable pins. There is also a "mark my position" control: paste
  coordinates from your phone's compass or map app (decimal, DMS, or
  degrees-decimal-minutes all parse) and it drops a pin, reads the elevation
  off the DEM, and gives distance and bearing to the summit. It is typed
  rather than sensed on purpose - `navigator.geolocation` requires a secure
  context, and a `file://` page is not one, so live GPS is unavailable in
  exactly the offline case these exports exist for. If the same export is
  served over https, a "Use GPS" button appears alongside it automatically.
  Phone-friendly exports downsample the grid to 1024
  (typical file 3-6 MB); full detail keeps up to 2048 (roughly 10-20 MB with
  layers). One iOS caveat: tapping an .html file on an iPhone opens Apple's
  Quick Look preview, which never runs JavaScript - so for iPhones pick the
  ".epub" format in the same dialog instead. The ePub wraps the identical
  interactive viewer and opens in Apple Books (preinstalled) with full 3D,
  orbit/pinch, and tappable pins - AirDrop it and tap. There is also "Export
  USDZ", which writes the terrain as a native AR Quick Look model - view-only,
  with the active layer draped, tracks drawn on, and pins as 3D markers.

## Running it

Backend (Python 3.12+):

```sh
cd backend
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/uvicorn app.main:app --port 8000
```

Frontend (Node 20+):

```sh
cd frontend
npm install
npm run dev
```

Open http://localhost:5173. Or run both with `./dev.sh`.

The backend is optional even here - the frontend alone works, going straight
to USGS. It is worth running in development because the Vite dev server
proxies `/api` to it and its `backend/cache/` makes repeat loads of an area
instant, where USGS re-renders on demand every time.

## Offline

A production build registers a service worker (dev builds do not - it would
serve stale Vite modules). Two caches with deliberately different lifetimes:

- **shell**, keyed to a hash of the built asset names. Replaced on each
  deploy, old versions deleted on activate.
- **data**, *not* versioned. Terrain payloads survive app updates - throwing
  away a few hundred MB of DEMs a user deliberately cached, because the CSS
  changed, would be the worst thing the worker could do. Only "Clear cache"
  removes it.

Terrain is cache-first and never revalidated, from whichever origin it came:
`/api/area/{id}/...` (area ids are a hash of the request parameters, so a
given URL's bytes cannot change), the USGS hosts, and the pre-bake origin.
Search and capabilities stay network-only. Without the USGS origins in that
list the backendless deployment would have no offline story at all, which is
the one that needs it most.

Session state - the current area, layer, exaggeration, units, and every
track, photo, and note - is written to IndexedDB (debounced), so a reload
restores the trip rather than losing it. The resolved `AreaMeta` is saved
alongside it, which is what makes an offline reload work at all: building an
area normally starts with `POST /api/area`, and a POST cannot be served from
the Cache API, so without the saved meta an offline reload would fail on its
first request with the heightmap sitting in cache.

The worker never calls `skipWaiting()`. An update installs behind the running
version and the page offers a reload, so a session in the field never has its
JavaScript swapped mid-use.

**iOS caveat.** WebKit clears all script-writable storage - IndexedDB, Cache
Storage, and the service worker registration - after seven days without a
visit. Someone who caches a peak at home and drives to the trailhead a week
later can arrive to an empty cache and no signal. Home-screen installs get
their own counter and are not swept, so the Offline panel tells people to use
Share -> Add to Home Screen. The app also calls
`navigator.storage.persist()` when the user asks it to.

## Where terrain comes from

Three sources, tried in order, all producing the same `AreaMeta` so nothing
downstream can tell them apart (`frontend/src/direct/source.ts`):

1. **Pre-baked** - a published static tile. The only source with predictable
   latency, and the reason pre-baking is worth doing at all: 3DEP renders
   exports on demand and has been measured anywhere from 1 s to over 45 s for
   the same kind of request.
2. **Backend** - the FastAPI proxy, if one answers `/api/capabilities`. Worth
   preferring when present because its disk cache is shared between everyone
   using that deployment.
3. **Direct** - the browser fetches 3DEP itself. Needs no server, which is
   what makes a static deploy possible.

Set `VITE_TERRAIN_SOURCE=direct` to skip the backend even when one is running,
which is how to exercise the static path during development.

The TIFF decoder (`frontend/src/direct/tiff.ts`) is hand-written rather than a
GeoTIFF library. The request is ours to control, and ArcGIS answers with one
predictable shape - classic little-endian, uncompressed, single-band float32,
in 128x128 tiles at every grid size - so handling exactly that costs ~150
lines against several hundred kB of dependency. It rejects anything else
rather than guessing.

**US-only without a backend.** The Terrarium fallback for areas outside 3DEP
lives in an S3 bucket that sends no CORS headers, so a browser cannot read it.
That is the same footprint as the lidar that justifies this tool and as the
bundled gazetteer, so it is an accepted limit rather than a bug.

`frontend/direct-check.html` compares a client build against the backend's
build of the same area; `frontend/direct-render.html` renders one end to end
with no backend involved. Both are dev harnesses, served by `npm run dev`.

## Pre-baking

`backend/scripts/prebake_peaks.py` publishes static tiles for a fixed set of
peaks. Output is plain files - any static host or object store serves them
with no server logic:

```
<out>/index.json                 manifest: areas and the peaks in each
<out>/<area_id>/meta.json        AreaMeta + heights_encoding
<out>/<area_id>/heights.u16.gz   quantized elevation, gzipped
<out>/<area_id>/topo.png         USGS topo
<out>/<area_id>/imagery.jpg      NAIP
```

Area ids use the same hash as the API, so a pre-baked tile, a client-built one
and a server-built one are the same cache entry.

Heights ship as uint16 with a min/scale rather than float32 - verified against
float32 ground truth at 1.05 cm maximum error, well inside 3DEP's own vertical
accuracy, for roughly half the bytes (12.9 MB -> 7.5 MB at 2048).

Peaks share a tile when they fit. Resolution is exactly `2000 * radius / grid`
regardless of latitude, so holding the radius fixed at 4 km keeps every tile at
3.91 m/px whether it covers one peak or five - grouping costs no detail, it
only stops the same terrain being fetched repeatedly. `--margin-km` sets how
much terrain every summit keeps around it, and with it how freely peaks may
share:

| `--margin-km` | areas | grouped | total |
|---|---|---|---|
| 1.0 | 32 | 15 | 387 MB |
| 2.0 | 36 | 14 | 435 MB |
| **3.0** (default) | **45** | **10** | **544 MB** |
| 4.0 | 58 | 0 | 701 MB |

```sh
python backend/scripts/prebake_peaks.py --plan          # preview, no network
python backend/scripts/prebake_peaks.py --out prebake   # ~25 min for the 14ers
```

Resumable - anything already written is skipped. Peaks that fall back to
Terrarium raise rather than shipping a tile a browser could not have built.

13ers are deliberately not pre-baked; they take the live 3DEP path. Re-run
`--plan` before baking them - they cluster far more densely, so the margin
constraint refuses many more merges and the area count will not scale the way
the 14ers did.

## Deploying

Static hosting is enough. The backend is ASGI and shared cPanel hosting
generally will not run it - which is why the client-side path exists.

```sh
cd frontend
MTNMKR_BASE=/mtnmkr/ VITE_PREBAKE_BASE=https://tiles.example.com npm run build
# rsync dist/ to the docroot subdirectory
```

- `MTNMKR_BASE` sets Vite's base path; omit for a root deploy. Trailing slash
  required.
- `VITE_PREBAKE_BASE` is where pre-baked tiles are published. Baked into the
  service worker too, so those tiles cache offline. Omit to skip the pre-bake
  lookup entirely.
- `VITE_API_BASE` points at a backend on another origin. **Leave it unset for
  a backendless deploy** - the app then goes direct to USGS, and the GeoTIFF
  control and worldwide search hide themselves.
- **Serve `sw.js` with `Cache-Control: no-cache`.** If a host caches the
  worker, users get pinned to whichever build they first saw and never see an
  update.
- Serving tiles from another origin (object storage) needs a CORS rule
  allowing `GET` from the app's origin.
- Upload `heights.u16.gz` *without* `Content-Encoding: gzip`. The loader
  sniffs the gzip magic number and handles either, but not setting it is one
  less thing to get wrong.

## Architecture

```
frontend/  React + TypeScript + Three.js
  viewer.ts        terrain mesh, draped textures, pins, fat-line tracks,
                   heightfield raymarch picking
  geo.ts           WGS84 <-> EPSG:3857 <-> scene space, bilinear DEM sampling,
                   coordinate parsing, distance/bearing
  parsers.ts       GPX / KML / KMZ / EXIF parsing (all client-side)
  store.ts         IndexedDB session persistence
  sw-template.js   service worker (built to dist/sw.js by vite.config.ts)
  direct/          the no-backend path
    source.ts        pre-baked -> backend -> direct, behind one call
    usgs.ts          port of backend geo.py + dem.py + imagery.py
    tiff.ts          float32 TIFF decoder for the 3DEP response
    gazetteer.ts     port of backend gazetteer.py
    prebake.ts       loads published static tiles
  standalone/      the offline viewer embedded in .html / .epub exports

backend/   FastAPI - optional; see "Where terrain comes from"
  dem.py            3DEP ImageServer export (primary), Terrarium tiles (fallback)
  imagery.py        USGS topo / NAIP basemap export for the same bbox
  custom_layers.py  user GeoTIFF -> warped PNG via rasterio (optional; see below)
  gazetteer.py      bundled USGS GNIS terrain index, searched in-process
  search.py         gazetteer by default, Photon proxy when opted in
  scripts/
    build_gnis_gazetteer.py   rebuild the bundled search index from USGS GNIS
    prebake_peaks.py          publish static tiles for a set of peaks
```

### Optional GDAL

`custom_layers.py` is the only module that needs rasterio, and therefore
GDAL: arbitrary user rasters arrive in arbitrary projections, so real
reprojection is unavoidable. Everything else - including decoding the float32
GeoTIFF that 3DEP returns - runs on numpy/Pillow/tifffile, because that
request already pins `bboxSR`/`imageSR` to 3857 and an exact pixel size, so no
CRS work is needed on our side.

So the rasterio import is soft. Without it the app does everything except
custom GeoTIFF layers; `/api/capabilities` reports `geotiff: false` and the
frontend hides the upload control. This matters for packaging: GDAL roughly
triples a bundled binary and is the most fragile piece to freeze (data files,
`proj.db`, hidden imports).

Everything is fetched in EPSG:3857 so DEM and textures align pixel-for-pixel;
the frontend multiplies by cos(lat) to recover true ground meters. Scene space
is x = east, y = up (meters), z = south, origin at the area center with the
lowest elevation at y = 0 so vertical exaggeration pivots correctly.

Heightmaps travel as raw little-endian float32 (`/api/area/{id}/heights`),
row 0 = north edge.

## Accuracy notes

- 3DEP elevations are NAVD88 orthometric heights; GPS/ellipsoid heights differ
  by the geoid offset (~ -20 m in the lower 48). Tracks are draped onto the
  DEM rather than trusting GPX elevation, which is usually the right call.
- The 3DEP ImageServer mosaics the best available source per pixel; the
  "m/px" figure shown in the Peak Data panel is the grid spacing you requested,
  not a guarantee that lidar exists for every pixel.

## Photogrammetry (phase 2)

Photos currently contribute as geo-anchored overlays, not geometry. The
planned seam for structure-from-motion refinement (COLMAP against the 3DEP
heightfield) is documented in `backend/app/photogrammetry.py`; the frontend
already treats heights as a fetched artifact, so a refined DEM is just
another endpoint.

## Data sources and licensing

- Elevation: USGS 3DEP (public domain), via the 3DEPElevation ImageServer
- Fallback elevation: Terrarium tiles on AWS Open Data (Mapzen/Linux
  Foundation, various upstream licenses)
- Topo and satellite: USGS National Map basemaps (public domain)
- Search: USGS GNIS domestic names (public domain), bundled
- Optional worldwide search: Photon by komoot, OSM data (ODbL; komoot's
  public instance is a demo service - "requests must stay in a reasonable
  limit," extensive use is throttled or banned, no uptime guarantee)
- Colorado peak index: 14ers.com waypoint export (use with caution, per
  their disclaimer)
