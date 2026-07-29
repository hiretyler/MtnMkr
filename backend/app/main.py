"""MtnMkr API.

Endpoints:
  POST /api/area                       build (or return cached) terrain for a lat/lon/radius
  GET  /api/area/{id}                  area metadata
  GET  /api/area/{id}/heights          raw float32 heightmap, row 0 = north edge
  GET  /api/area/{id}/texture/{layer}  draped USGS texture (topo | imagery)
  POST /api/area/{id}/layers           upload a GeoTIFF, warped onto the area
  GET  /api/area/{id}/layers/{lid}     the warped custom layer as PNG
  GET  /api/search?q=                  peak / place geocoding
"""

import hashlib
import json
import math

import httpx
import numpy as np
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pydantic import BaseModel, Field

from . import custom_layers, dem, geo, imagery
from . import search as search_mod
from .cache import CACHE_ROOT, area_dir

ALLOWED_SIZES = (256, 512, 1024, 2048)

app = FastAPI(title="MtnMkr API")
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"]
)

client = httpx.Client(
    timeout=httpx.Timeout(240.0, connect=15.0),
    follow_redirects=True,
    headers={"User-Agent": "MtnMkr/0.1 (personal project)"},
)


class AreaRequest(BaseModel):
    lat: float = Field(ge=-85, le=85)
    lon: float = Field(ge=-180, le=180)
    radius_km: float = Field(default=4.0, ge=0.5, le=20.0)
    size: int = Field(default=1024)
    name: str | None = None


def _load_meta(area_id: str) -> dict:
    p = CACHE_ROOT / area_id / "meta.json"
    if not p.exists():
        raise HTTPException(404, "Unknown area. Build the terrain first.")
    return json.loads(p.read_text())


@app.get("/api/health")
def health():
    return {"ok": True}


@app.post("/api/area")
def create_area(req: AreaRequest):
    if req.size not in ALLOWED_SIZES:
        raise HTTPException(400, f"size must be one of {ALLOWED_SIZES}")
    key = f"{req.lat:.5f},{req.lon:.5f},{req.radius_km:.2f},{req.size}"
    area_id = hashlib.sha1(key.encode()).hexdigest()[:12]
    d = area_dir(area_id)
    meta_path = d / "meta.json"
    if meta_path.exists():
        meta = json.loads(meta_path.read_text())
        if req.name and not meta.get("name"):
            meta["name"] = req.name
            meta_path.write_text(json.dumps(meta))
        return meta

    bbox = geo.area_bbox(req.lat, req.lon, req.radius_km)
    try:
        heights, source = dem.get_dem(bbox, req.size, client)
    except Exception as e:
        raise HTTPException(502, f"Elevation fetch failed: {e}")
    np.save(d / "heights.npy", heights)

    k = math.cos(math.radians(req.lat))
    meta = {
        "id": area_id,
        "name": req.name,
        "lat": req.lat,
        "lon": req.lon,
        "radius_km": req.radius_km,
        "size": req.size,
        "width": int(heights.shape[1]),
        "height": int(heights.shape[0]),
        "bbox3857": list(bbox),
        "cos_lat": k,
        "ground_size_m": req.radius_km * 2000.0,
        "resolution_m": (bbox[2] - bbox[0]) / req.size * k,
        "dem_source": source,
        "min_elev": float(heights.min()),
        "max_elev": float(heights.max()),
    }
    meta_path.write_text(json.dumps(meta))
    return meta


@app.get("/api/area/{area_id}")
def get_area(area_id: str):
    return _load_meta(area_id)


@app.get("/api/area/{area_id}/heights")
def get_heights(area_id: str):
    _load_meta(area_id)
    arr = np.load(CACHE_ROOT / area_id / "heights.npy")
    return Response(
        arr.astype("<f4").tobytes(), media_type="application/octet-stream"
    )


@app.get("/api/area/{area_id}/texture/{layer}")
def get_texture(area_id: str, layer: str, size: int = 2048):
    meta = _load_meta(area_id)
    if layer not in imagery.SERVICES:
        raise HTTPException(404, f"Unknown layer '{layer}'")
    size = max(256, min(size, 4096))
    _, fmt, media_type = imagery.SERVICES[layer]
    cache_file = CACHE_ROOT / area_id / f"tex_{layer}_{size}.{fmt}"
    if cache_file.exists():
        return Response(cache_file.read_bytes(), media_type=media_type)
    try:
        content, media_type = imagery.fetch_basemap(layer, meta["bbox3857"], size, client)
    except Exception as e:
        raise HTTPException(502, f"Texture fetch failed: {e}")
    cache_file.write_bytes(content)
    return Response(content, media_type=media_type)


@app.post("/api/area/{area_id}/layers")
async def upload_layer(area_id: str, file: UploadFile = File(...)):
    meta = _load_meta(area_id)
    data = await file.read()
    if len(data) > 300 * 1024 * 1024:
        raise HTTPException(413, "GeoTIFF is larger than 300 MB")
    try:
        png = custom_layers.geotiff_to_texture(data, meta["bbox3857"])
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        raise HTTPException(400, f"Could not read that file as a GeoTIFF: {e}")
    layer_id = hashlib.sha1(data).hexdigest()[:10]
    (CACHE_ROOT / area_id / f"custom_{layer_id}.png").write_bytes(png)
    return {
        "layer_id": layer_id,
        "name": file.filename,
        "url": f"/api/area/{area_id}/layers/{layer_id}",
    }


@app.get("/api/area/{area_id}/layers/{layer_id}")
def get_custom_layer(area_id: str, layer_id: str):
    p = CACHE_ROOT / area_id / f"custom_{layer_id}.png"
    if not p.exists():
        raise HTTPException(404, "Unknown custom layer")
    return Response(p.read_bytes(), media_type="image/png")


@app.get("/api/search")
def search(q: str):
    try:
        return search_mod.geocode(q, client)
    except Exception as e:
        raise HTTPException(502, f"Geocoding failed: {e}")


@app.post("/api/area/{area_id}/photogrammetry")
def photogrammetry(area_id: str):
    raise HTTPException(
        501,
        "Photogrammetry refinement is a planned phase 2 feature. "
        "Photos are currently placed as geo-anchored overlays.",
    )
