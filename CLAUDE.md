# MtnMkr - session context

Browser app that builds 3D models of US mountains from USGS 3DEP lidar and
drapes trip data (GPX/photos/notes) over them. **Live at
https://tgeddes.dev/mtnmkr/** - deployed backendless; the FastAPI backend in
`backend/` still exists for dev and for the GeoTIFF-upload feature, but
production is static files + Cloudflare R2 + the browser fetching USGS
directly (they send CORS on the image responses).

## Stable facts

- **Deploy**: `DEPLOY.md` is the runbook and carries the real values (R2
  bucket `mtnmkr-tiles`, public dev URL, CORS, rsync target). Frontend builds
  need `MTNMKR_BASE=/mtnmkr/` and `VITE_PREBAKE_BASE=<r2 url>`; leave
  `VITE_API_BASE` unset for the backendless deploy.
- **Pre-baked terrain**: the 58 Colorado 14ers as 45 static tiles on R2
  (2048 DEM grid, 4096 textures, area id = hash of lat/lon/radius/grid).
  `backend/scripts/prebake_peaks.py`. Re-baking changes every area id -
  upload new dirs + `index.json`, then delete retired dirs; the service
  worker fetches the manifest network-first for exactly this reason, and the
  app falls back to live USGS textures when a pre-baked one is gone.
- **Peak index**: `frontend/src/data/colorado-peaks.json` is GNIS names +
  3DEP-sampled elevations (all public domain - the 14ers.com data was
  removed for licensing). Regenerate with
  `backend/scripts/gnis_to_peaks_json.py` (GNIS stopped shipping elevations
  in 2021; borderline peaks need the dense-patch max the script does).
- **Service worker** (`frontend/src/sw-template.js`): shell cache versioned
  per deploy; terrain cache stable across deploys and URL-keyed - tiles are
  immutable, `index.json` is the one mutable file (network-first). `sw.js`
  must be served no-cache (handled in tgeddes.dev's `.htaccess`).
- **tgeddes.dev repo**: its `deploy.sh` excludes `mtnmkr/` - do not remove
  that exclude, its `--delete` would wipe the app.
- **Viewer** (`frontend/src/viewer.ts`): hand-rolled around MapControls;
  picking/probing via heightfield raymarch, not mesh raycast. Zoom-detail
  patches + relief hillshade ride one onBeforeCompile injection on the
  terrain material; detail engagement gates on look-at distance (< 3 km).
- **Testing gotcha**: the render loop, camera damping, rest detection, and
  `img.decode()` all park when the tab is hidden - check
  `document.visibilityState` before trusting browser-automation results.

## Working style

- Verify in the real deployed app, not just tsc - every shipped bug this
  project has had was runtime-interaction, invisible in review.
- Commit only when verified; Tyler says when to push.
- No em dashes in code comments or docs - hyphens.
- Distillation: learnings go to the Obsidian vault via /distill (see
  `~/vault/Projects/mtnmkr.md` for the project note and session log).

## Current status / open threads (update when they change)

- Detail patches verified at state level only - the blend's pixels still
  need one human eyeball pass (verification window was backgrounded).
- Photogrammetry/splats: analysis done, nothing built - see README
  "Photogrammetry and 3D scans" for the client-local plan and phases.
- Relief suite (2026-08-08): sun-position sliders (E-S-W arc), worker-baked
  cast shadows + sky-view AO, slope-angle tint, contour overlay, and
  DEM-backed detail-patch shading all verified in-browser at the state and
  network level; the close-zoom detail-shade pixels still want one human
  eyeball pass. The HTML/ePub exports now carry the whole suite too (relief
  slider + Shading panel; worker base64-inlined via ?worker&inline and
  spawned from a blob URL, sync no-shadow bake as fallback) - verified over
  http and as strict XHTML, but not yet on an actual iPhone in Books.
- Browser-automation aid: in dev builds the live Viewer instance is exposed
  as `window.__viewer` - drive the camera/private methods directly instead
  of synthetic wheel events (the hidden-tab parking gotcha above).
- 13ers deliberately not pre-baked (slow live path is intentional).
- Runbook checks never done: offline reload, iPhone home-screen install.
- r2.dev public URL is rate-limited (dev tier); upgrade path is a custom
  domain on Cloudflare DNS - deferred.
- Write-up drafts: `reddit-post.md` (repo root, untracked) and
  `tgeddes.dev/content/mtnmkr-writeup.md` - drafted, not posted.
