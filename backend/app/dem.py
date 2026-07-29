"""Elevation fetching.

Primary source: the USGS 3DEP ImageServer, which mosaics the best available
3DEP data (down to 1 m lidar over most US mountains) and can export an
arbitrary bbox as float32 GeoTIFF in one request - no tile downloads, no
mosaicking on our side.

Fallback: AWS Terrarium terrain tiles (global, ~30 m outside the US) for
areas 3DEP does not cover.
"""

import io
import math

import httpx
import numpy as np
import rasterio
from PIL import Image

IMAGE_SERVER = (
    "https://elevation.nationalmap.gov/arcgis/rest/services/"
    "3DEPElevation/ImageServer/exportImage"
)
TERRARIUM_URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"
MERC_ORIGIN = 20037508.342789244

Image.MAX_IMAGE_PIXELS = None


def _clean(arr: np.ndarray) -> np.ndarray | None:
    """Replace nodata / absurd values; return None if essentially empty."""
    a = arr.astype(np.float32)
    valid = np.isfinite(a) & (a > -12000.0) & (a < 12000.0)
    if a.size == 0 or float(valid.mean()) < 0.05:
        return None
    fill = float(a[valid].min())
    return np.where(valid, a, fill).astype(np.float32)


def fetch_3dep(bbox, size: int, client: httpx.Client) -> np.ndarray | None:
    params = {
        "bbox": f"{bbox[0]},{bbox[1]},{bbox[2]},{bbox[3]}",
        "bboxSR": "3857",
        "imageSR": "3857",
        "size": f"{size},{size}",
        "format": "tiff",
        "pixelType": "F32",
        "interpolation": "RSP_BilinearInterpolation",
        "f": "image",
    }
    r = client.get(IMAGE_SERVER, params=params)
    r.raise_for_status()
    if "tiff" not in r.headers.get("content-type", ""):
        return None  # ArcGIS reports errors as JSON with HTTP 200
    with rasterio.MemoryFile(r.content) as mf:
        with mf.open() as ds:
            arr = ds.read(1)
    return _clean(arr)


def fetch_terrarium(bbox, size: int, client: httpx.Client) -> np.ndarray:
    xmin, ymin, xmax, ymax = bbox
    px_res = (xmax - xmin) / size
    z = int(round(math.log2(2 * MERC_ORIGIN / 256 / max(px_res, 1e-9))))
    z = max(1, min(z, 13))
    n = 2 ** z
    world = 2 * MERC_ORIGIN

    def to_px(x: float, y: float) -> tuple[float, float]:
        return (
            (x + MERC_ORIGIN) / world * n * 256,
            (MERC_ORIGIN - y) / world * n * 256,
        )

    x0, y0 = to_px(xmin, ymax)  # top-left
    x1, y1 = to_px(xmax, ymin)  # bottom-right
    tx0, ty0 = int(x0 // 256), int(y0 // 256)
    tx1, ty1 = int((x1 - 1e-6) // 256), int((y1 - 1e-6) // 256)
    ty0, ty1 = max(ty0, 0), min(ty1, n - 1)

    mosaic = np.zeros(((ty1 - ty0 + 1) * 256, (tx1 - tx0 + 1) * 256), np.float32)
    for ty in range(ty0, ty1 + 1):
        for tx in range(tx0, tx1 + 1):
            r = client.get(TERRARIUM_URL.format(z=z, x=tx % n, y=ty))
            if r.status_code != 200:
                continue
            img = np.asarray(Image.open(io.BytesIO(r.content)).convert("RGB"), np.float32)
            h = img[:, :, 0] * 256.0 + img[:, :, 1] + img[:, :, 2] / 256.0 - 32768.0
            mosaic[
                (ty - ty0) * 256 : (ty - ty0 + 1) * 256,
                (tx - tx0) * 256 : (tx - tx0 + 1) * 256,
            ] = h

    r0 = max(int(y0 - ty0 * 256), 0)
    r1 = min(int(math.ceil(y1 - ty0 * 256)), mosaic.shape[0])
    c0 = max(int(x0 - tx0 * 256), 0)
    c1 = min(int(math.ceil(x1 - tx0 * 256)), mosaic.shape[1])
    crop = mosaic[r0:r1, c0:c1]
    if crop.size == 0:
        return np.zeros((size, size), np.float32)
    im = Image.fromarray(crop, mode="F").resize((size, size), Image.BILINEAR)
    return np.asarray(im, np.float32).copy()


def get_dem(bbox, size: int, client: httpx.Client) -> tuple[np.ndarray, str]:
    try:
        arr = fetch_3dep(bbox, size, client)
    except Exception:
        arr = None
    if arr is not None:
        return arr, "usgs-3dep"
    return fetch_terrarium(bbox, size, client), "terrarium"
