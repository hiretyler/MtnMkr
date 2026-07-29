"""Draped texture fetching from USGS basemap services (public domain).

Both services accept an EPSG:3857 bbox and return a rendered image that
aligns pixel-for-pixel with the DEM grid we request for the same bbox.
"""

import httpx

SERVICES = {
    "topo": (
        "https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/export",
        "png",
        "image/png",
    ),
    "imagery": (
        "https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/export",
        "jpg",
        "image/jpeg",
    ),
}


def fetch_basemap(layer: str, bbox, size: int, client: httpx.Client) -> tuple[bytes, str]:
    url, fmt, media_type = SERVICES[layer]
    r = client.get(
        url,
        params={
            "bbox": f"{bbox[0]},{bbox[1]},{bbox[2]},{bbox[3]}",
            "bboxSR": "3857",
            "imageSR": "3857",
            "size": f"{size},{size}",
            "format": fmt,
            "transparent": "false",
            "f": "image",
        },
    )
    r.raise_for_status()
    ctype = r.headers.get("content-type", "")
    if not ctype.startswith("image/"):
        raise RuntimeError(f"{layer} service returned {ctype} instead of an image")
    return r.content, media_type
