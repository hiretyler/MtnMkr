"""Build the bundled terrain gazetteer from USGS GNIS domestic names.

GNIS (the US Board on Geographic Names' Geographic Names Information System)
is public domain, which is why it is bundled rather than queried live: it
carries no attribution or share-alike obligation, and it removes the app's
dependency on komoot's public Photon demo API, whose terms only cover
"reasonable" request volumes (see app/search.py).

Coverage is US-only, which matches where this tool is actually worth using -
3DEP lidar stops at the border, and outside it the app falls back to the same
~30 m tiles Google Earth already has.

Usage:
    python backend/scripts/build_gnis_gazetteer.py

Writes frontend/public/gnis_terrain.tsv.gz (regenerate when GNIS updates; the
file is committed so the app works from a clean checkout). It lives under the
frontend's static assets because the browser fetches it directly when search
runs client-side; the backend reads the same file from that path, so there is
only ever one copy.
"""

import csv
import gzip
import io
import sys
import urllib.request
import zipfile
from pathlib import Path

SOURCE = (
    "https://prd-tnm.s3.amazonaws.com/StagedProducts/GeographicNames/"
    "DomesticNames/DomesticNames_AllStates_Text.zip"
)

# Written into the frontend's static assets: the browser fetches this
# directly when search runs client-side, and the backend reads the same file
# from there. One copy, one source of truth.
OUT = (
    Path(__file__).resolve().parent.parent.parent
    / "frontend"
    / "public"
    / "gnis_terrain.tsv.gz"
)

# GNIS feature classes that are terrain anchors. Mirrors what the Photon path
# selected with osm_tag=natural + mountain_pass, minus the aquatic types.
# Ordered by how likely the user means it when searching this app; the index
# stores the rank so search can break ties without a second lookup.
CLASSES = [
    "Summit",
    "Range",
    "Gap",
    "Ridge",
    "Pillar",
    "Glacier",
    "Crater",
    "Arch",
    "Cliff",
    "Basin",
    "Valley",
    "Falls",
    "Slope",
    "Bench",
    "Flat",
    "Lava",
    "Isthmus",
]
RANK = {c: i for i, c in enumerate(CLASSES)}

# GNIS ships full state names; the UI has room for postal codes.
STATE_ABBR = {
    "Alabama": "AL", "Alaska": "AK", "American Samoa": "AS", "Arizona": "AZ",
    "Arkansas": "AR", "California": "CA", "Colorado": "CO", "Connecticut": "CT",
    "Delaware": "DE", "District of Columbia": "DC", "Florida": "FL",
    "Georgia": "GA", "Guam": "GU", "Hawaii": "HI", "Idaho": "ID",
    "Illinois": "IL", "Indiana": "IN", "Iowa": "IA", "Kansas": "KS",
    "Kentucky": "KY", "Louisiana": "LA", "Maine": "ME", "Maryland": "MD",
    "Massachusetts": "MA", "Michigan": "MI", "Minnesota": "MN",
    "Mississippi": "MS", "Missouri": "MO", "Montana": "MT", "Nebraska": "NE",
    "Nevada": "NV", "New Hampshire": "NH", "New Jersey": "NJ",
    "New Mexico": "NM", "New York": "NY", "North Carolina": "NC",
    "North Dakota": "ND", "Northern Mariana Islands": "MP", "Ohio": "OH",
    "Oklahoma": "OK", "Oregon": "OR", "Pennsylvania": "PA",
    "Puerto Rico": "PR", "Rhode Island": "RI", "South Carolina": "SC",
    "South Dakota": "SD", "Tennessee": "TN", "Texas": "TX", "Utah": "UT",
    "Vermont": "VT", "Virgin Islands": "VI", "Virginia": "VA",
    "Washington": "WA", "West Virginia": "WV", "Wisconsin": "WI",
    "Wyoming": "WY",
}


def main() -> int:
    print(f"Fetching {SOURCE}", file=sys.stderr)
    with urllib.request.urlopen(SOURCE) as r:
        blob = r.read()
    print(f"  {len(blob) / 1048576:.1f} MB", file=sys.stderr)

    rows: list[tuple[int, str, str, str, float, float]] = []
    with zipfile.ZipFile(io.BytesIO(blob)) as z:
        names = [n for n in z.namelist() if n.endswith(".txt")]
        for name in sorted(names):
            with z.open(name) as fh:
                # utf-8-sig: the per-state files carry a BOM on the header line
                reader = csv.DictReader(
                    io.TextIOWrapper(fh, "utf-8-sig"), delimiter="|"
                )
                for rec in reader:
                    cls = rec.get("feature_class", "")
                    if cls not in RANK:
                        continue
                    try:
                        lat = float(rec["prim_lat_dec"])
                        lon = float(rec["prim_long_dec"])
                    except (KeyError, TypeError, ValueError):
                        continue
                    # GNIS uses 0.0/0.0 for records with no primary point
                    if lat == 0.0 and lon == 0.0:
                        continue
                    fname = (rec.get("feature_name") or "").strip()
                    if not fname:
                        continue
                    state = STATE_ABBR.get(rec.get("state_name", ""), "")
                    county = (rec.get("county_name") or "").strip()
                    rows.append((RANK[cls], fname, cls, state, county, lat, lon))

    # Sort by class rank then name so equally-scored hits come out in a stable,
    # sensible order and the file gzips well (adjacent rows share prefixes).
    rows.sort(key=lambda r: (r[0], r[1].lower()))

    OUT.parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(OUT, "wt", encoding="utf-8", newline="", compresslevel=9) as out:
        w = csv.writer(out, delimiter="\t", lineterminator="\n")
        for rank, fname, cls, state, county, lat, lon in rows:
            w.writerow([fname, cls, state, county, f"{lat:.5f}", f"{lon:.5f}"])

    print(
        f"Wrote {OUT}: "
        f"{len(rows):,} features, {OUT.stat().st_size / 1048576:.1f} MB gz",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
