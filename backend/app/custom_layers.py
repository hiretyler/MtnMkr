"""User-provided GeoTIFF handling.

A user can drop in their own georeferenced raster (a scanned USGS quad, a
drone orthomosaic, a historic topo) and we warp it onto the area's EPSG:3857
grid so it drapes exactly over the terrain mesh.
"""

import io

import numpy as np
import rasterio
from PIL import Image
from rasterio.enums import Resampling
from rasterio.io import MemoryFile
from rasterio.transform import from_bounds
from rasterio.warp import reproject

NODATA_GRAY = 205


def geotiff_to_texture(data: bytes, bbox, size: int = 2048) -> bytes:
    """Warp an uploaded GeoTIFF onto the area bbox; returns PNG bytes."""
    with MemoryFile(data) as mf:
        with mf.open() as src:
            if src.crs is None:
                raise ValueError(
                    "This GeoTIFF has no coordinate system. Export it with "
                    "georeferencing (a .tif with embedded CRS) and try again."
                )
            colormap = None
            try:
                colormap = src.colormap(1)
            except Exception:
                colormap = None

            count = 1 if colormap else min(src.count, 3)
            resampling = Resampling.nearest if colormap else Resampling.bilinear
            dst_transform = from_bounds(*bbox, size, size)

            bands = []
            for i in range(1, count + 1):
                dst = np.full((size, size), np.nan, np.float32)
                reproject(
                    source=rasterio.band(src, i),
                    destination=dst,
                    dst_transform=dst_transform,
                    dst_crs="EPSG:3857",
                    resampling=resampling,
                    dst_nodata=np.nan,
                )
                bands.append(dst)
            src_dtype = src.dtypes[0]

    invalid = ~np.isfinite(bands[0])
    rgb = np.zeros((size, size, 3), np.uint8)

    if colormap:
        lut_size = max(colormap.keys()) + 1
        lut = np.full((lut_size, 3), NODATA_GRAY, np.uint8)
        for k, v in colormap.items():
            lut[k] = v[:3]
        idx = np.clip(np.nan_to_num(bands[0], nan=0), 0, lut_size - 1).astype(np.int32)
        rgb = lut[idx]
    elif src_dtype == "uint8":
        arrs = bands if len(bands) == 3 else [bands[0]] * 3
        for j, b in enumerate(arrs):
            rgb[:, :, j] = np.clip(np.nan_to_num(b, nan=0), 0, 255).astype(np.uint8)
    else:
        # 16-bit / float rasters: stretch each band to its 2-98 percentile
        arrs = bands if len(bands) == 3 else [bands[0]] * 3
        for j, b in enumerate(arrs):
            valid = np.isfinite(b)
            if not valid.any():
                continue
            lo, hi = np.percentile(b[valid], [2, 98])
            if hi <= lo:
                hi = lo + 1
            x = np.clip((np.nan_to_num(b, nan=lo) - lo) / (hi - lo), 0, 1)
            rgb[:, :, j] = (x * 255).astype(np.uint8)

    rgb[invalid] = NODATA_GRAY

    buf = io.BytesIO()
    Image.fromarray(rgb).save(buf, format="PNG")
    return buf.getvalue()
