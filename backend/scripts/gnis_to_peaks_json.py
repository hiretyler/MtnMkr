"""Build the bundled Colorado peak index from public-domain sources.

Names and coordinates come from the USGS GNIS Domestic Names file for
Colorado (feature_class "Summit"); elevations are sampled from the same
3DEP ImageServer the app renders terrain from, so the list agrees with
what a visitor actually sees. Everything upstream is US-government public
domain - no third-party gazetteer terms involved.

GNIS dropped elevations in its 2021 file-format change (USGS points users
at 3DEP instead), which is why the sampling pass exists at all.

Usage:
    python3 backend/scripts/gnis_to_peaks_json.py DomesticNames_CO.txt \
        frontend/src/data/colorado-peaks.json

The GNIS file: https://prd-tnm.s3.amazonaws.com/StagedProducts/
GeographicNames/DomesticNames/DomesticNames_CO_Text.zip

Two passes: every summit is sampled once at its GNIS point; anything that
lands near the 13,000 / 14,000 ft class boundaries gets a dense ~2.3 m/px
DEM patch (+-150 m) and takes its max. Sparse point sampling misses summit
pixels by enough to misclassify borderline peaks - measured on Mount of the
Holy Cross (14,005 ft): 30 m-spaced samples topped out at 13,992, the dense
patch reads 14,004.8.

GNIS quirks handled here: variant-name records like "Gannett Peak (not
official)" (a second point on Mount Massive) are dropped by name; collective
features ("Maroon Bells", "Crestone Peaks") sit on the same point as a member
peak and are removed by proximity dedupe, keeping the shorter name.
"""

import csv
import json
import math
import sys
import time
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import dem, geo  # noqa: E402

GET_SAMPLES = (
    "https://elevation.nationalmap.gov/arcgis/rest/services/"
    "3DEPElevation/ImageServer/getSamples"
)
FT = 0.3048
MIN_FT = 13000.0
# First-pass elevations within this many feet of a class boundary get the
# window refinement.
BOUNDARY_SLOP_FT = 120.0
# getSamples resolves each point against the full-resolution mosaic; 100-point
# batches drew steady 504s, 25 is reliable.
BATCH = 25


def load_summits(gnis_path: str) -> list[dict]:
    with open(gnis_path, encoding="utf-8-sig") as f:
        rows = csv.DictReader(f, delimiter="|")
        out = []
        for r in rows:
            if r["feature_class"] != "Summit":
                continue
            try:
                lat = float(r["prim_lat_dec"])
                lon = float(r["prim_long_dec"])
            except (KeyError, TypeError, ValueError):
                continue
            name = r["feature_name"].strip()
            if not name or lat == 0.0 or "(not official)" in name:
                continue
            out.append({"n": name, "lat": lat, "lon": lon})
        return out


def dedupe_nearby(peaks: list[dict], radius_m: float = 100.0) -> list[dict]:
    """Collapse entries that share a summit point (collective features like
    "Maroon Bells" sit metres from "Maroon Peak"). The shorter name wins -
    the collectives and variant records are consistently the longer ones."""
    keep: list[dict] = []
    for p in sorted(peaks, key=lambda p: len(p["n"])):
        k = math.cos(math.radians(p["lat"]))
        if any(
            math.hypot((p["lon"] - q["lon"]) * 111320 * k, (p["lat"] - q["lat"]) * 110574)
            < radius_m
            for q in keep
        ):
            continue
        keep.append(p)
    return keep


def sample_batch(client: httpx.Client, points: list[tuple[float, float]]) -> dict:
    """(lon, lat) -> elevation in meters; NoData points are absent."""
    geometry = {"points": [[x, y] for x, y in points], "spatialReference": {"wkid": 4326}}
    for attempt in range(4):
        try:
            resp = client.post(
                GET_SAMPLES,
                data={
                    "geometry": json.dumps(geometry),
                    "geometryType": "esriGeometryMultipoint",
                    "returnFirstValueOnly": "true",
                    "f": "json",
                },
                timeout=90.0,
            )
            resp.raise_for_status()
            samples = resp.json().get("samples", [])
            got = {}
            for s in samples:
                try:
                    val = float(s["value"])
                except (KeyError, TypeError, ValueError):
                    continue  # "NoData"
                loc = s["location"]
                got[(round(loc["x"], 6), round(loc["y"], 6))] = val
            return got
        except (httpx.HTTPError, ValueError) as e:
            if attempt == 3:
                raise
            time.sleep(2.0 * (attempt + 1))
            print(f"  retry ({e})", file=sys.stderr)
    return {}


def lookup(got: dict, lon: float, lat: float) -> float | None:
    return got.get((round(lon, 6), round(lat, 6)))


def main(gnis_path: str, json_path: str) -> None:
    summits = load_summits(gnis_path)
    print(f"{len(summits)} GNIS summits in Colorado", flush=True)

    with httpx.Client() as client:
        for i in range(0, len(summits), BATCH):
            chunk = summits[i : i + BATCH]
            got = sample_batch(client, [(s["lon"], s["lat"]) for s in chunk])
            for s in chunk:
                s["e"] = lookup(got, s["lon"], s["lat"])
            print(f"  sampled {min(i + BATCH, len(summits))}/{len(summits)}", flush=True)

        # Dense-refine anything near a class boundary: a +-150 m DEM patch at
        # ~2.3 m/px, take its max. Small enough that no neighboring named
        # summit can bleed in; dense enough to actually contain the summit
        # pixel, which 30 m point sampling misses.
        near = [
            s
            for s in summits
            if s["e"] is not None
            and any(
                abs(s["e"] / FT - b) <= BOUNDARY_SLOP_FT for b in (13000.0, 14000.0)
            )
        ]
        print(f"{len(near)} summits near a boundary; dense-refining", flush=True)
        for i, s in enumerate(near, 1):
            bbox = geo.area_bbox(s["lat"], s["lon"], 0.15)
            heights, _ = dem.get_dem(bbox, 128, client)
            s["e"] = max(s["e"], float(heights.max()))
            if i % 20 == 0 or i == len(near):
                print(f"  refined {i}/{len(near)}", flush=True)

    peaks = [
        {"n": s["n"], "lat": round(s["lat"], 5), "lon": round(s["lon"], 5), "e": round(s["e"], 1)}
        for s in summits
        if s["e"] is not None and s["e"] >= MIN_FT * FT
    ]
    peaks = dedupe_nearby(peaks)
    peaks.sort(key=lambda p: -p["e"])
    with open(json_path, "w") as f:
        json.dump(peaks, f, separators=(",", ":"))
    n14 = sum(1 for p in peaks if p["e"] / FT >= 14000.0)
    print(f"wrote {len(peaks)} peaks ({n14} 14ers) -> {json_path}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
