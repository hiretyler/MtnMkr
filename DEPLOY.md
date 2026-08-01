# Deploy runbook

Target: the app served from **https://tgeddes.dev/mtnmkr/** (static, no
backend), with pre-baked terrain on **Cloudflare R2**.

First executed 2026-07-31; the site is live. Current production values:

- R2 bucket: `mtnmkr-tiles` (location hint `wnam`), public dev URL
  `https://pub-f6a251cb37ab4ae5939e965c6c6b45a2.r2.dev`
- CORS on the bucket: `GET`/`HEAD` from `https://tgeddes.dev`, max-age 86400
- Upload was done with `wrangler r2 object put` per file (wrangler OAuth;
  rclone works too but needs an R2 API token created in the dashboard)

Background on why this shape was chosen is in the README ("Where terrain
comes from", "Deploying").

The three steps are independent and resumable in this order.

---

## 1. Bake the 14ers

```sh
cd /Users/tylergeddes/projects/MtnMkr
backend/.venv/bin/python backend/scripts/prebake_peaks.py --plan
backend/.venv/bin/python backend/scripts/prebake_peaks.py --out prebake
```

Defaults: 2048 grid, 4 km radius, `--margin-km 3.0`. Expect **45 areas (10
grouped), ~544 MB, roughly 25 minutes** - almost all of it waiting on USGS,
which renders exports on demand.

- `--plan` prints the area list and exits without touching the network. Worth
  running first to confirm the grouping still looks right.
- Resumable: re-running skips anything already written, so an interrupted run
  just picks up.
- A peak that falls back to Terrarium raises rather than writing a tile,
  because a browser could not have built the same thing (that bucket sends no
  CORS headers). None of the Colorado 14ers should hit this.

Sanity check before uploading:

```sh
python3 -c "
import json; d=json.load(open('prebake/index.json'))
print(len(d['areas']), 'areas,', sum(len(a['peaks']) for a in d['areas']), 'peaks')"
du -sh prebake
```

`prebake/` is gitignored - it is build output, not source.

## 2. Upload to R2

Bucket holds ~544 MB, inside R2's 10 GB free tier, and egress is free.

```sh
rclone sync prebake/ r2:mtnmkr-tiles/ --progress
```

Two settings that matter:

- **CORS rule on the bucket** allowing `GET` from `https://tgeddes.dev`.
  Without it the browser blocks the fetches even though the objects are
  public.
- **Do not set `Content-Encoding: gzip`** on `heights.u16.gz`. The loader
  sniffs the gzip magic number and handles either case, but leaving the header
  off avoids the double-decompress ambiguity entirely.

Re-baking later: changed coordinates or settings change every area id.
Upload the new area dirs plus the new `index.json` (same URL - the service
worker deliberately fetches the manifest network-first, because a
cache-first manifest would pin clients to retired area ids), then delete
the retired dirs. Clients holding a stale manifest fall back to the live
path until their next fetch; nothing breaks.

Verify one object end to end before moving on:

```sh
curl -sI -H "Origin: https://tgeddes.dev" \
  https://pub-f6a251cb37ab4ae5939e965c6c6b45a2.r2.dev/index.json \
  | grep -i "access-control\|content-type"
```

(The `Origin` header matters: R2 only emits the CORS headers on requests
that carry one, so a bare `curl -sI` looks broken when it is not.)

## 3. Build and deploy the frontend

```sh
cd frontend
MTNMKR_BASE=/mtnmkr/ \
VITE_PREBAKE_BASE=https://pub-f6a251cb37ab4ae5939e965c6c6b45a2.r2.dev \
npm run build
```

**Leave `VITE_API_BASE` unset.** With no backend the app goes direct to USGS,
and the GeoTIFF control and worldwide-search toggle hide themselves. Setting it
would point the app at a backend that is not there.

Both variables are baked into `dist/sw.js` as well as the app bundle, so
pre-baked tiles and USGS responses are cacheable offline. The build fails loudly
if any placeholder went unsubstituted.

Then push `dist/` to the docroot:

```sh
rsync -avz --delete -e "ssh -i ~/.ssh/tgeddes_dev -p 21098" \
  dist/ tgedlpaf@tgeddes.dev:/home/tgedlpaf/public_html/tgeddes.dev/mtnmkr/
```

### Two things on the tgeddes.dev side

1. **`deploy.sh` in the tgeddes.dev repo uses `--delete` and would wipe
   `mtnmkr/` on its next run.** Fixed 2026-07-31: it now has an
   `--exclude 'mtnmkr/'` line alongside the existing `playground/` and
   `kidplan/` entries.

2. **`sw.js` must be served with `Cache-Control: no-cache`.** Also done
   2026-07-31: the tgeddes.dev repo's `.htaccess` (which is what lands on the
   server) now carries, alongside its `.html` rule:

   ```apache
   <FilesMatch "sw\.js$">
     Header set Cache-Control "no-cache, must-revalidate"
   </FilesMatch>
   ```

   Miss this and visitors get pinned to whichever build they first loaded and
   never see an update.

## Verifying the deploy

1. Load `https://tgeddes.dev/mtnmkr/` - the Colorado index should populate from
   the bundled peaks JSON immediately.
2. Open a pre-baked 14er (Mt. Elbert). Should appear in a second or two, not
   tens of seconds. Confirm in DevTools that the request went to the R2 domain.
3. Open a 13er. Expect the slow live path - this is intentional; 13ers are not
   pre-baked.
4. Confirm the GeoTIFF button and the worldwide-search toggle are **absent**.
   Both require a backend.
5. Reload, then go offline (DevTools > Network > Offline) and reload again. The
   app and the last peak should both come back from cache.
6. On an iPhone, add it to the Home Screen. WebKit clears all script-writable
   storage after seven days without a visit, and home-screen installs are
   exempt - the Offline panel says so, but it is worth confirming the prompt
   appears.

## If something is wrong

- **Blank page, 404s on assets** - `MTNMKR_BASE` missing or lacking its
  trailing slash.
- **Terrain never loads, console shows CORS errors** - the R2 bucket's CORS
  rule, or `VITE_PREBAKE_BASE` pointing somewhere unreachable. The app should
  fall back to direct USGS, so if *nothing* loads the problem is more likely
  the app bundle than the tiles.
- **Stuck on an old build** - `sw.js` is being cached. See item 2 above. To
  recover a browser by hand: DevTools > Application > Service Workers >
  Unregister, then hard reload.
- **Everything works locally but not deployed** - rebuild with the same env
  vars and diff `dist/sw.js`; the injected `PREBAKE_BASE` and `API_BASE`
  constants are near the top and are the usual culprits.
