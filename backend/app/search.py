"""Peak / terrain-feature search, proxied through Photon (komoot's OSM
geocoder).

Photon is used instead of Nominatim because it supports server-side class
filtering (osm_tag). Nominatim ranks by general importance, so a query like
"capitol" returns bus stations and theaters and the actual Capitol Peak
never cracks the top 30 - post-filtering cannot fix what ranking never
returns. Photon with osm_tag=natural searches only terrain features.
"""

import httpx

PHOTON = "https://photon.komoot.io/api/"

# Aquatic types that come along with the "natural" class but are not
# terrain anchors for this tool
EXCLUDE_TYPES = {"water", "bay", "strait", "reef", "shoal", "wetland", "coastline"}


def geocode(q: str, client: httpx.Client) -> list[dict]:
    r = client.get(
        PHOTON,
        params={
            "q": q,
            "limit": 20,
            "osm_tag": ["natural", "mountain_pass"],
        },
        headers={"User-Agent": "MtnMkr/0.1 (personal project)"},
    )
    r.raise_for_status()
    out: list[dict] = []
    seen: set[tuple] = set()
    for feat in r.json().get("features", []):
        props = feat.get("properties", {})
        rtype = props.get("osm_value", "")
        if rtype in EXCLUDE_TYPES:
            continue
        try:
            lon, lat = feat["geometry"]["coordinates"][:2]
            lon, lat = float(lon), float(lat)
        except (KeyError, TypeError, ValueError, IndexError):
            continue
        name = props.get("name", "")
        if not name:
            continue
        key = (name.lower(), round(lat, 2), round(lon, 2))
        if key in seen:
            continue
        seen.add(key)
        region = ", ".join(
            p for p in (props.get("state"), props.get("country")) if p
        )
        out.append(
            {
                "name": f"{name}, {region}" if region else name,
                "lat": lat,
                "lon": lon,
                "type": rtype,
            }
        )
        if len(out) >= 8:
            break
    return out
