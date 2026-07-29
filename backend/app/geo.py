"""Web Mercator helpers.

The app works in EPSG:3857 for data fetching because every source we use
(3DEP ImageServer, USGS basemaps, Terrarium tiles) serves it natively.
Mercator meters are inflated by 1/cos(lat); the frontend multiplies by
cos(lat) to recover true ground meters, which is accurate to well under
0.1% over the <= 40 km areas this tool works with.
"""

import math

R = 6378137.0


def lonlat_to_merc(lon: float, lat: float) -> tuple[float, float]:
    x = math.radians(lon) * R
    y = R * math.log(math.tan(math.pi / 4 + math.radians(lat) / 2))
    return x, y


def merc_to_lonlat(x: float, y: float) -> tuple[float, float]:
    lon = math.degrees(x / R)
    lat = math.degrees(2 * math.atan(math.exp(y / R)) - math.pi / 2)
    return lon, lat


def area_bbox(lat: float, lon: float, radius_km: float) -> tuple[float, float, float, float]:
    """Square EPSG:3857 bbox centered on (lat, lon) spanning 2*radius_km of
    true ground distance on each side."""
    cx, cy = lonlat_to_merc(lon, lat)
    k = math.cos(math.radians(lat))
    half = radius_km * 1000.0 / k
    return (cx - half, cy - half, cx + half, cy + half)
