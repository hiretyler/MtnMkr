# MtnMkr

Build a 3D model of a mountain that is more accurate than Google Earth, then
drape your own trip data over it.

Google Earth terrain in the mountains is roughly 10-30 m resolution. Over most
US mountains, USGS 3DEP has 1 m lidar. MtnMkr fetches the best available 3DEP
elevation for the area you pick, builds a terrain mesh from it, and lets you
layer USGS topo sheets, NAIP satellite imagery, your own georeferenced rasters,
GPS tracks, geotagged photos, and trip notes on top.

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
  server-side.
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

The Vite dev server proxies `/api` to the backend on port 8000. Fetched DEMs
and textures are cached in `backend/cache/`, so the first load of an area is
slow (USGS renders the export on demand) and repeats are instant.

## Offline

A production build registers a service worker (dev builds do not - it would
serve stale Vite modules). Two caches with deliberately different lifetimes:

- **shell**, keyed to a hash of the built asset names. Replaced on each
  deploy, old versions deleted on activate.
- **data**, *not* versioned. Terrain payloads survive app updates - throwing
  away a few hundred MB of DEMs a user deliberately cached, because the CSS
  changed, would be the worst thing the worker could do. Only "Clear cache"
  removes it.

`/api/area/{id}/...` responses are cache-first and never revalidated: area
ids are a hash of the request parameters, so a given URL's bytes cannot
change. Search and capabilities stay network-only.

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

## Deploying the frontend

```sh
cd frontend
MTNMKR_BASE=/mtnmkr/ VITE_API_BASE=https://api.example.com npm run build
# rsync dist/ to the docroot subdirectory
```

- `MTNMKR_BASE` sets Vite's base path; omit it for a root deploy. It must have
  a trailing slash.
- `VITE_API_BASE` points the frontend at a backend on another origin, and is
  baked into the service worker too so terrain from that origin is still
  cached. Omit it for same-origin. The backend sends
  `Access-Control-Allow-Origin: *`, which is fine for a personal deploy and
  wants tightening before anything public.
- **Serve `sw.js` with `Cache-Control: no-cache`.** If a host caches the
  worker itself, users get pinned to whichever build they first saw and never
  see an update.
- Static hosting is enough for the frontend, but the backend is a separate
  problem: it is ASGI, and shared cPanel hosting generally will not run it.
  Without a reachable backend the app can still open peaks already cached on
  the device, but search and new terrain will not work.

## Architecture

```
frontend/  React + TypeScript + Three.js
  viewer.ts    terrain mesh, draped textures, pins, fat-line tracks,
               heightfield raymarch picking
  geo.ts       WGS84 <-> EPSG:3857 <-> scene space, bilinear DEM sampling
  parsers.ts   GPX / KML / KMZ / EXIF parsing (all client-side)

backend/   FastAPI
  dem.py            3DEP ImageServer export (primary), Terrarium tiles (fallback)
  imagery.py        USGS topo / NAIP basemap export for the same bbox
  custom_layers.py  user GeoTIFF -> warped PNG via rasterio (optional; see below)
  gazetteer.py      bundled USGS GNIS terrain index, searched in-process
  search.py         gazetteer by default, Photon proxy when opted in
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
