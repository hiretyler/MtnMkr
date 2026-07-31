/**
 * Direct-to-USGS terrain, with no backend in between.
 *
 * Every service this app reads from - the 3DEP ImageServer and the National
 * Map basemaps - answers with `Access-Control-Allow-Origin: *`, including on
 * the image responses themselves. So the browser can fetch elevation and
 * imagery itself, and the FastAPI proxy turns out to be optional for
 * everything except user-uploaded GeoTIFFs (which need real reprojection, and
 * therefore GDAL).
 *
 * This is a port of backend/app/{geo,dem,imagery}.py. It deliberately mirrors
 * the same bbox math and the same nodata cleaning so a client-built area is
 * numerically identical to a server-built one - see area id below.
 *
 * Known gap: the Terrarium fallback for areas outside 3DEP coverage is served
 * from an S3 bucket with no CORS headers, so it cannot be fetched here. That
 * limits the backend-free path to the United States - which is the same
 * footprint as the lidar that makes this tool worth using, and the same
 * footprint as the bundled GNIS gazetteer.
 */

import type { AreaMeta } from '../types'
import { decodeFloat32Tiff } from './tiff'

const R = 6378137.0

const IMAGE_SERVER =
  'https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage'

const BASEMAPS = {
  topo: 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/export',
  imagery:
    'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/export',
} as const

export type Bbox = [number, number, number, number]

function lonLatToMerc(lon: number, lat: number): [number, number] {
  return [(lon * Math.PI * R) / 180, R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))]
}

/** Square EPSG:3857 bbox spanning 2*radiusKm of true ground distance a side. */
export function areaBbox(lat: number, lon: number, radiusKm: number): Bbox {
  const [cx, cy] = lonLatToMerc(lon, lat)
  const half = (radiusKm * 1000.0) / Math.cos((lat * Math.PI) / 180)
  return [cx - half, cy - half, cx + half, cy + half]
}

/**
 * Stable id for an area, matching the backend's cache key so the two can share
 * a service-worker cache and a saved session. The backend uses
 * sha1(`{lat:.5f},{lon:.5f},{radius:.2f},{size}`)[:12]; SubtleCrypto has no
 * SHA-1-free path worth avoiding here, and the value is a cache key, not a
 * security boundary.
 */
export async function areaId(
  lat: number,
  lon: number,
  radiusKm: number,
  size: number,
): Promise<string> {
  const key = `${lat.toFixed(5)},${lon.toFixed(5)},${radiusKm.toFixed(2)},${size}`
  const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(key))
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 12)
}

/** Replace nodata / absurd values the same way backend/app/dem.py does. */
function clean(a: Float32Array): Float32Array | null {
  let min = Infinity
  let valid = 0
  for (let i = 0; i < a.length; i++) {
    const v = a[i]
    if (Number.isFinite(v) && v > -12000 && v < 12000) {
      valid++
      if (v < min) min = v
    }
  }
  if (!a.length || valid / a.length < 0.05) return null
  for (let i = 0; i < a.length; i++) {
    const v = a[i]
    if (!(Number.isFinite(v) && v > -12000 && v < 12000)) a[i] = min
  }
  return a
}

export function demUrl(bbox: Bbox, size: number): string {
  const p = new URLSearchParams({
    bbox: bbox.join(','),
    bboxSR: '3857',
    imageSR: '3857',
    size: `${size},${size}`,
    format: 'tiff',
    pixelType: 'F32',
    interpolation: 'RSP_BilinearInterpolation',
    f: 'image',
  })
  return `${IMAGE_SERVER}?${p}`
}

export function textureUrl(bbox: Bbox, layer: 'topo' | 'imagery', size = 2048): string {
  const p = new URLSearchParams({
    bbox: bbox.join(','),
    bboxSR: '3857',
    imageSR: '3857',
    size: `${size},${size}`,
    format: layer === 'topo' ? 'png' : 'jpg',
    f: 'image',
  })
  return `${BASEMAPS[layer]}?${p}`
}

export interface BuiltArea {
  meta: AreaMeta
  heights: Float32Array
  bbox: Bbox
}

/**
 * Build an area entirely in the browser: fetch the DEM from 3DEP, decode it,
 * and derive the same metadata the backend would have returned.
 */
export async function buildArea(
  lat: number,
  lon: number,
  radiusKm: number,
  size: number,
  name: string | null = null,
  signal?: AbortSignal,
): Promise<BuiltArea> {
  const bbox = areaBbox(lat, lon, radiusKm)
  const res = await fetch(demUrl(bbox, size), { signal })
  if (!res.ok) throw new Error(`3DEP request failed (${res.status})`)
  // ArcGIS reports errors as JSON with HTTP 200
  const type = res.headers.get('content-type') ?? ''
  if (!type.includes('tiff')) {
    throw new Error('3DEP returned no elevation for that area (outside coverage?)')
  }

  const raster = decodeFloat32Tiff(await res.arrayBuffer())
  const heights = clean(raster.data)
  if (!heights) {
    throw new Error('3DEP returned an empty tile for that area')
  }

  let min = Infinity
  let max = -Infinity
  for (let i = 0; i < heights.length; i++) {
    if (heights[i] < min) min = heights[i]
    if (heights[i] > max) max = heights[i]
  }

  const k = Math.cos((lat * Math.PI) / 180)
  const meta: AreaMeta = {
    id: await areaId(lat, lon, radiusKm, size),
    name,
    lat,
    lon,
    radius_km: radiusKm,
    size,
    width: raster.width,
    height: raster.height,
    bbox3857: bbox,
    cos_lat: k,
    ground_size_m: radiusKm * 2000.0,
    resolution_m: ((bbox[2] - bbox[0]) / size) * k,
    dem_source: 'usgs-3dep',
    min_elev: min,
    max_elev: max,
  }
  return { meta, heights, bbox }
}
