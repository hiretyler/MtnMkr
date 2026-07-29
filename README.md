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
- **Colorado index**: one-click, filterable lists of all Colorado 14ers and
  13ers (14ers.com waypoint data, bundled as JSON - regenerate with
  `backend/scripts/gpx_to_peaks_json.py`). Search still covers the rest of
  the world.
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
  custom_layers.py  user GeoTIFF -> warped PNG via rasterio
  search.py         Photon geocoding proxy (terrain features only)
```

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
  "m/px" figure shown in the Sheet panel is the grid spacing you requested,
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
- Geocoding: Photon by komoot, OSM data (ODbL; light personal use)
- Colorado peak index: 14ers.com waypoint export (use with caution, per
  their disclaimer)
