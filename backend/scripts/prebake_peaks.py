"""Pre-bake terrain for a fixed set of peaks into static files.

Why: with the client fetching 3DEP directly there is no shared server cache,
so every visitor pays USGS's own render time for a cold area - measured
anywhere from 1 s to well over 45 s, depending on their caching, not ours.
Pre-baking the peaks people actually open turns that into a plain static
download.

Output is deliberately dumb - a directory of files any static host or object
store can serve, with no server logic:

    <out>/index.json                 manifest: peaks -> area id
    <out>/<area_id>/meta.json        AreaMeta + how heights are encoded
    <out>/<area_id>/heights.u16.gz   quantized elevation, gzipped
    <out>/<area_id>/topo.png         USGS topo, 2048
    <out>/<area_id>/imagery.jpg      NAIP, 2048

Area ids are the same hash the API uses, so a pre-baked area and a
client-built one are the same cache key.

Heights ship as uint16 rather than float32: the value stored is
round((elev - min) / (max - min) * 65535), which over a 1,750 m tile has a
maximum error of about 1.4 cm - far inside 3DEP's own vertical accuracy - and
cuts the gzipped payload roughly in half (12.9 MB -> 7.5 MB at 2048).

Usage:
    python backend/scripts/prebake_peaks.py --out prebake
    python backend/scripts/prebake_peaks.py --out prebake --size 1024 --limit 5
    python backend/scripts/prebake_peaks.py --out prebake --include-unranked

Resumable: anything already written is skipped, so a run interrupted halfway
picks up where it left off. Baking all 58 ranked 14ers at 2048 moves roughly
1 GB and can take well over an hour, most of it waiting on USGS.
"""

import argparse
import gzip
import hashlib
import json
import math
import sys
import time
from pathlib import Path

import httpx
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import dem, geo, imagery  # noqa: E402

PEAKS_JSON = (
    Path(__file__).resolve().parent.parent.parent
    / "frontend"
    / "src"
    / "data"
    / "colorado-peaks.json"
)
FT = 0.3048


def area_id(lat: float, lon: float, radius_km: float, size: int) -> str:
    """Must match main.py's cache key exactly."""
    key = f"{lat:.5f},{lon:.5f},{radius_km:.2f},{size}"
    return hashlib.sha1(key.encode()).hexdigest()[:12]


def haversine_km(a: dict, b: dict) -> float:
    la, lb = math.radians(a["lat"]), math.radians(b["lat"])
    dlat = lb - la
    dlon = math.radians(b["lon"] - a["lon"])
    h = math.sin(dlat / 2) ** 2 + math.cos(la) * math.cos(lb) * math.sin(dlon / 2) ** 2
    return 2 * 6371.0088 * math.asin(math.sqrt(h))


def _xy_km(p: dict) -> tuple[float, float]:
    """Local planar coords in km. Good enough over a single state."""
    k = math.cos(math.radians(p["lat"]))
    return p["lon"] * 111.320 * k, p["lat"] * 110.574


def half_extent_km(group: list[dict]) -> float:
    """Half the group's widest span - the square half-side it needs."""
    xs = [_xy_km(p)[0] for p in group]
    ys = [_xy_km(p)[1] for p in group]
    return max((max(xs) - min(xs)) / 2, (max(ys) - min(ys)) / 2)


def group_peaks(peaks: list[dict], max_half_km: float) -> list[list[dict]]:
    """Merge peaks into shared tiles, never past max_half_km of spread.

    Colorado's 14ers come in tight clusters - Grays and Torreys a kilometre
    apart, the Crestones, the Bells - so a tile per peak fetches the same
    terrain several times over. Grouping removes that duplication.

    The constraint is what keeps quality fixed. Resolution is exactly
    2000 * radius / grid regardless of latitude, so every tile stays at the
    same m/px as long as the radius does; what varies is how close a summit
    sits to the edge of its tile. Capping the group's spread at
    (radius - margin) guarantees every peak keeps at least `margin` km of
    terrain around it, and any cluster too spread out to satisfy that simply
    does not merge - it falls back to its own centred tile rather than
    quietly cropping a summit.

    Greedy agglomerative rather than single-linkage: single-linkage chains
    (A near B, B near C) and can drag a group past the cap in one step, which
    is exactly the case the margin is meant to prevent.
    """
    groups: list[list[dict]] = [[p] for p in peaks]
    while True:
        best: tuple[float, int, int] | None = None
        for i in range(len(groups)):
            for j in range(i + 1, len(groups)):
                if half_extent_km(groups[i] + groups[j]) > max_half_km:
                    continue
                ci = [sum(c) / len(c) for c in zip(*[_xy_km(p) for p in groups[i]])]
                cj = [sum(c) / len(c) for c in zip(*[_xy_km(p) for p in groups[j]])]
                d = math.dist(ci, cj)
                if best is None or d < best[0]:
                    best = (d, i, j)
        if best is None:
            break
        _, i, j = best
        groups[i] = groups[i] + groups[j]
        groups.pop(j)

    for g in groups:
        g.sort(key=lambda p: -p["e"])
    return sorted(groups, key=lambda g: -g[0]["e"])


def enclosing_area(group: list[dict], radius_km: float) -> tuple[float, float, float]:
    """Centre a fixed-radius square on the group. Returns (lat, lon, radius_km).

    The radius is deliberately the same for every area - that is what holds
    resolution constant across the whole bake.
    """
    lat0 = sum(p["lat"] for p in group) / len(group)
    k = math.cos(math.radians(lat0))
    xs = [p["lon"] * 111.320 * k for p in group]
    ys = [p["lat"] * 110.574 for p in group]
    cx, cy = (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2
    clat = cy / 110.574
    clon = cx / (111.320 * math.cos(math.radians(clat)))
    return round(clat, 5), round(clon, 5), radius_km


def load_peaks(min_ft: float, max_ft: float, include_unranked: bool) -> list[dict]:
    peaks = json.loads(PEAKS_JSON.read_text())
    out = []
    for p in peaks:
        ft = p["e"] / FT
        if not (min_ft <= ft < max_ft):
            continue
        # 14ers.com wraps unofficial / unranked summits in quotes. Those are
        # mostly subpeaks a few hundred metres from a ranked peak, so baking
        # them duplicates terrain that is already covered.
        if not include_unranked and p["n"].startswith('"'):
            continue
        out.append(p)
    return out


def quantize(heights: np.ndarray) -> tuple[bytes, float, float]:
    lo = float(heights.min())
    hi = float(heights.max())
    span = max(hi - lo, 1e-9)
    q = np.round((heights - lo) / span * 65535.0).astype("<u2")
    return q.tobytes(), lo, hi


def bake_one(
    lat: float,
    lon: float,
    label: str,
    radius_km: float,
    size: int,
    tex_size: int,
    out_root: Path,
    client: httpx.Client,
) -> tuple[str, bool]:
    """Returns (area_id, did_work)."""
    aid = area_id(lat, lon, radius_km, size)
    d = out_root / aid
    meta_path = d / "meta.json"
    heights_path = d / "heights.u16.gz"
    topo_path = d / "topo.png"
    img_path = d / "imagery.jpg"

    if all(p.exists() for p in (meta_path, heights_path, topo_path, img_path)):
        return aid, False

    d.mkdir(parents=True, exist_ok=True)
    bbox = geo.area_bbox(lat, lon, radius_km)

    if not (meta_path.exists() and heights_path.exists()):
        heights, source = dem.get_dem(bbox, size, client)
        if source != "usgs-3dep":
            # Terrarium cannot be fetched by a browser (no CORS on that
            # bucket), so a peak that falls back to it would behave
            # differently pre-baked than live. Skip rather than ship a
            # silently inconsistent tile.
            raise RuntimeError(f"no 3DEP coverage (fell back to {source})")
        raw, lo, hi = quantize(heights)
        heights_path.write_bytes(gzip.compress(raw, 6))
        k = math.cos(math.radians(lat))
        meta_path.write_text(
            json.dumps(
                {
                    "id": aid,
                    "name": label,
                    "lat": lat,
                    "lon": lon,
                    "radius_km": radius_km,
                    "size": size,
                    "width": int(heights.shape[1]),
                    "height": int(heights.shape[0]),
                    "bbox3857": list(bbox),
                    "cos_lat": k,
                    "ground_size_m": radius_km * 2000.0,
                    "resolution_m": (bbox[2] - bbox[0]) / size * k,
                    "dem_source": "usgs-3dep",
                    "min_elev": lo,
                    "max_elev": hi,
                    # How to turn the uint16 payload back into metres
                    "heights_encoding": {
                        "dtype": "uint16",
                        "endian": "little",
                        "min": lo,
                        "max": hi,
                        "scale": (hi - lo) / 65535.0,
                    },
                },
                indent=1,
            )
        )

    for layer, path in (("topo", topo_path), ("imagery", img_path)):
        if path.exists():
            continue
        content, _ = imagery.fetch_basemap(layer, list(bbox), tex_size, client)
        path.write_bytes(content)

    return aid, True


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", default="prebake", help="output directory")
    ap.add_argument("--size", type=int, default=2048, help="DEM grid (default 2048)")
    ap.add_argument("--tex-size", type=int, default=2048, help="texture size")
    ap.add_argument("--radius", type=float, default=4.0, help="area radius in km")
    ap.add_argument("--min-ft", type=float, default=14000.0)
    ap.add_argument("--max-ft", type=float, default=99000.0)
    ap.add_argument("--include-unranked", action="store_true")
    ap.add_argument(
        "--margin-km",
        type=float,
        default=3.0,
        help="terrain guaranteed around every peak; also caps how far a group may "
        "spread (0 packs tightest, --radius means no grouping at all)",
    )
    ap.add_argument("--limit", type=int, default=0, help="bake at most N areas")
    ap.add_argument("--plan", action="store_true", help="print the plan and exit")
    ap.add_argument("--delay", type=float, default=1.0, help="seconds between peaks")
    args = ap.parse_args()

    peaks = load_peaks(args.min_ft, args.max_ft, args.include_unranked)

    # Build the area plan: each entry is (lat, lon, radius_km, [peaks]).
    # A group may spread at most radius - margin, so every peak keeps at least
    # margin km of terrain between it and the edge of its tile.
    max_half = max(args.radius - args.margin_km, 0.0)
    areas = [
        (*enclosing_area(g, args.radius), g) for g in group_peaks(peaks, max_half)
    ]
    areas.sort(key=lambda a: -a[3][0]["e"])
    if args.limit:
        areas = areas[: args.limit]

    out_root = Path(args.out).resolve()
    res = args.radius * 2000.0 / args.size
    clearance = min(args.radius - half_extent_km(g) for _, _, _, g in areas)
    grouped = sum(1 for _, _, _, g in areas if len(g) > 1)
    print(
        f"{len(peaks)} peaks -> {len(areas)} areas ({grouped} grouped) -> {out_root}\n"
        f"grid {args.size}, radius {args.radius} km, {res:.2f} m/px everywhere, "
        f"min clearance {clearance:.2f} km, ~{len(areas) * 12.08:.0f} MB",
        file=sys.stderr,
    )
    if args.plan:
        for lat, lon, r, g in areas:
            names = ", ".join(p["n"].strip('"') for p in g)
            print(
                f"  clear {r - half_extent_km(g):4.1f} km  {lat:9.5f},{lon:11.5f}  {names}",
                file=sys.stderr,
            )
        return 0
    out_root.mkdir(parents=True, exist_ok=True)

    client = httpx.Client(
        timeout=httpx.Timeout(600.0, connect=15.0),
        follow_redirects=True,
        headers={"User-Agent": "MtnMkr prebake (https://github.com/hiretyler/MtnMkr)"},
    )

    manifest = []
    failures = []
    for i, (lat, lon, radius, group) in enumerate(areas, 1):
        # The area is named for its highest peak; every member is listed so the
        # UI can offer "Grays Peak" and "Torreys Peak" as separate entry points
        # into the same tile.
        label = group[0]["n"].strip('"')
        t0 = time.time()
        try:
            aid, worked = bake_one(
                lat, lon, label, radius, args.size, args.tex_size, out_root, client
            )
        except Exception as e:
            print(f"[{i}/{len(areas)}] {label}: FAILED - {e}", file=sys.stderr)
            failures.append({"name": label, "error": str(e)})
            continue
        manifest.append(
            {
                "name": label,
                "lat": lat,
                "lon": lon,
                "id": aid,
                "radius_km": radius,
                "size": args.size,
                "peaks": [
                    {"name": p["n"].strip('"'), "lat": p["lat"], "lon": p["lon"], "elev_m": p["e"]}
                    for p in group
                ],
            }
        )
        used = sum(f.stat().st_size for f in (out_root / aid).iterdir())
        note = f"{time.time() - t0:5.1f}s" if worked else "cached"
        extra = f" +{len(group) - 1}" if len(group) > 1 else "   "
        print(
            f"[{i}/{len(areas)}] {label:24s}{extra} {aid}  {used / 1048576:6.2f} MB  {note}",
            file=sys.stderr,
        )
        if worked:
            time.sleep(args.delay)

    (out_root / "index.json").write_text(
        json.dumps(
            {
                "version": 1,
                "size": args.size,
                "areas": manifest,
            },
            indent=1,
        )
    )

    total = sum(f.stat().st_size for f in out_root.rglob("*") if f.is_file())
    print(
        f"\n{len(manifest)} baked, {len(failures)} failed, {total / 1073741824:.2f} GB total",
        file=sys.stderr,
    )
    for f in failures:
        print(f"  failed: {f['name']} - {f['error']}", file=sys.stderr)
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
