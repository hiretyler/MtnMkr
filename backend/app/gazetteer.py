"""Bundled US terrain gazetteer (USGS GNIS, public domain).

This is the default search backend. It ships with the app so search works
with no third-party service, no API key, and no request budget - see
search.py for why that matters.

The index is a gzipped TSV built by scripts/build_gnis_gazetteer.py, loaded
lazily on the first query and kept in memory afterwards (~190k features,
tens of MB resident). Lookup is a linear scan with a small scoring function;
at this size that lands well under a typing-latency budget, and it avoids
shipping a search-engine dependency for one text box.
"""

import csv
import gzip
import sys
import threading
from pathlib import Path

DATA = Path(__file__).resolve().parent / "data" / "gnis_terrain.tsv.gz"

# Search-result priority when scores tie. Mirrors the build script's class
# ordering; a query that hits a summit and a valley should show the summit.
CLASS_RANK = {
    "Summit": 0, "Range": 1, "Gap": 2, "Ridge": 3, "Pillar": 4,
    "Glacier": 5, "Crater": 6, "Arch": 7, "Cliff": 8, "Basin": 9,
    "Valley": 10, "Falls": 11, "Slope": 12, "Bench": 13, "Flat": 14,
    "Lava": 15, "Isthmus": 16,
}

# (name, lower_name, feature_class, state, county, lat, lon)
_rows: list[tuple[str, str, str, str, str, float, float]] | None = None
_lock = threading.Lock()


def available() -> bool:
    return DATA.exists()


def _load() -> list[tuple[str, str, str, str, str, float, float]]:
    global _rows
    if _rows is not None:
        return _rows
    with _lock:
        if _rows is not None:  # another thread won the race
            return _rows
        rows = []
        with gzip.open(DATA, "rt", encoding="utf-8", newline="") as fh:
            for rec in csv.reader(fh, delimiter="\t"):
                if len(rec) != 6:
                    continue
                name, cls, state, county, lat, lon = rec
                try:
                    lat_f, lon_f = float(lat), float(lon)
                except ValueError:
                    continue
                # class/state/county repeat across ~190k rows from a few
                # thousand distinct values; interning collapses the copies.
                rows.append(
                    (
                        name,
                        name.lower(),
                        sys.intern(cls),
                        sys.intern(state),
                        sys.intern(county),
                        lat_f,
                        lon_f,
                    )
                )
        _rows = rows
    return _rows


def _score(needle: str, hay: str) -> int:
    """Lower is better; None-equivalent is -1 meaning no match.

    Ranked so that "capitol" puts Capitol Peak above Capitol Reef Valley, and
    an exact "Little Bear Peak" beats "Little Bear Peak Southwest Ridge".
    """
    if hay == needle:
        return 0
    if hay.startswith(needle):
        return 1
    # word-boundary hit: "bear peak" should match "Little Bear Peak"
    if f" {needle}" in hay:
        return 2
    if needle in hay:
        return 3
    return -1


# Names GNIS files under a different official name than people search for.
# GNIS carries only the current official name per feature, so a search for a
# widely-used alternative finds nothing (or, worse, finds an unrelated minor
# feature that happens to share the word). Kept deliberately tiny - this is
# for names where the mismatch is nationally known, not a synonym dictionary.
ALIASES = {
    "denali": "mount mckinley",
}


def search(q: str, limit: int = 8) -> list[dict]:
    needle = " ".join(q.lower().split())
    if not needle:
        return []
    needle = ALIASES.get(needle, needle)
    rows = _load()

    # Group by name so the result list can show variety. GNIS has 200-plus
    # Bald Mountains and six Capitol Peaks; ranking purely by score buries
    # everything else under near-identical rows.
    groups: dict[str, list[tuple]] = {}
    for name, lower, cls, state, county, lat, lon in rows:
        s = _score(needle, lower)
        if s < 0:
            continue
        # Prefer the shorter name among equal-quality matches: "Bear Peak"
        # over "Bear Peak Trailhead Overlook".
        groups.setdefault(lower, []).append(
            (s, CLASS_RANK.get(cls, 99), len(name), name, cls, state, county, lat, lon)
        )

    for g in groups.values():
        g.sort(key=lambda h: h[:3])
    ordered = sorted(groups.values(), key=lambda g: g[0][:3])

    # Round-robin: every distinct name contributes its best hit before any
    # name contributes a second. Quality ordering still governs within a round.
    out: list[dict] = []
    seen: set[tuple] = set()
    for depth in range(max((len(g) for g in ordered), default=0)):
        for g in ordered:
            if depth >= len(g):
                continue
            _, _, _, name, cls, state, county, lat, lon = g[depth]
            # Same feature mapped twice (GNIS carries variant records)
            # collapses; genuinely distinct peaks sharing a name do not,
            # which is why county rides along in the label.
            key = (name.lower(), round(lat, 2), round(lon, 2))
            if key in seen:
                continue
            seen.add(key)
            region = ", ".join(p for p in (county, state) if p)
            out.append(
                {
                    "name": f"{name}, {region}" if region else name,
                    "lat": lat,
                    "lon": lon,
                    "type": cls.lower(),
                }
            )
            if len(out) >= limit:
                return out
    return out
