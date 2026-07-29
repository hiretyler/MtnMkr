"""Convert a waypoint GPX (e.g. the 14ers.com all-peaks export) into the
compact JSON peak index the frontend bundles.

Usage:
    python3 backend/scripts/gpx_to_peaks_json.py all14ersand13ers.gpx \
        frontend/src/data/colorado-peaks.json

Output: [{"n": name, "lat": ..., "lon": ..., "e": elevation_m}, ...]
sorted by elevation descending. Keys are short because the file ships in
the frontend bundle.
"""

import json
import sys
import xml.etree.ElementTree as ET


def convert(gpx_path: str, json_path: str) -> None:
    root = ET.parse(gpx_path).getroot()
    peaks = []
    # iterfind, not iter: only the find* family supports {*} wildcards
    for wpt in root.iterfind(".//{*}wpt"):
        try:
            lat = float(wpt.attrib["lat"])
            lon = float(wpt.attrib["lon"])
        except (KeyError, ValueError):
            continue
        name_el = wpt.find("{*}name")
        ele_el = wpt.find("{*}ele")
        if name_el is None or ele_el is None or not name_el.text:
            continue
        try:
            ele = float(ele_el.text)
        except (TypeError, ValueError):
            continue
        peaks.append(
            {
                "n": name_el.text.strip(),
                "lat": round(lat, 5),
                "lon": round(lon, 5),
                "e": round(ele, 1),
            }
        )
    peaks.sort(key=lambda p: -p["e"])
    with open(json_path, "w") as f:
        json.dump(peaks, f, separators=(",", ":"))
    print(f"{len(peaks)} peaks -> {json_path}")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    convert(sys.argv[1], sys.argv[2])
