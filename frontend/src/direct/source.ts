/**
 * Where terrain comes from.
 *
 * Three sources, tried in order, all producing the same AreaMeta + heights so
 * the rest of the app cannot tell them apart:
 *
 *   1. pre-baked   a published static tile. Instant, and the only source with
 *                  predictable latency - 3DEP renders exports on demand and
 *                  takes anywhere from a second to well over a minute.
 *   2. backend     the FastAPI proxy, when one is reachable. Worth preferring
 *                  over going direct because its disk cache is shared between
 *                  everyone using that deployment.
 *   3. direct      the browser fetches 3DEP itself. Needs no server at all,
 *                  which is what makes a static deploy possible.
 *
 * Set VITE_TERRAIN_SOURCE=direct to skip the backend even when one exists -
 * useful for exercising the static path while a dev server is running.
 */

import * as api from '../api'
import type { AreaMeta, Capabilities } from '../types'
import { loadPrebaked } from './prebake'
import { buildArea, textureUrl as usgsTextureUrl, type Bbox } from './usgs'

/** Where pre-baked tiles are published. Empty disables the pre-bake lookup. */
export const PREBAKE_BASE: string = (import.meta.env.VITE_PREBAKE_BASE ?? '').replace(/\/$/, '')

const FORCE_DIRECT = import.meta.env.VITE_TERRAIN_SOURCE === 'direct'

export type TerrainSource = 'prebake' | 'backend' | 'direct'

export interface LoadedArea {
  meta: AreaMeta
  heights: Float32Array
  source: TerrainSource
  /** Absolute URLs for the draped layers, wherever they happen to live. */
  textures: { topo: string; imagery: string }
}

function usgsTextures(bbox: Bbox): { topo: string; imagery: string } {
  return { topo: usgsTextureUrl(bbox, 'topo'), imagery: usgsTextureUrl(bbox, 'imagery') }
}

export async function loadArea(
  lat: number,
  lon: number,
  radiusKm: number,
  size: number,
  name: string | null,
  caps: Capabilities | null,
  onProgress?: (msg: string) => void,
): Promise<LoadedArea> {
  if (PREBAKE_BASE) {
    onProgress?.('Looking for a pre-built map...')
    const pre = await loadPrebaked(PREBAKE_BASE, lat, lon, radiusKm, size)
    if (pre) {
      return { meta: pre.meta, heights: pre.heights, source: 'prebake', textures: pre.textures }
    }
  }

  if (caps && !FORCE_DIRECT) {
    onProgress?.('Requesting elevation from USGS 3DEP (first load can take a minute)...')
    const meta = await api.createArea({ lat, lon, radius_km: radiusKm, size, name })
    onProgress?.('Downloading heightmap...')
    const heights = await api.fetchHeights(meta.id)
    return {
      meta,
      heights,
      source: 'backend',
      textures: {
        topo: api.textureUrl(meta.id, 'topo'),
        imagery: api.textureUrl(meta.id, 'imagery'),
      },
    }
  }

  onProgress?.('Fetching elevation from USGS 3DEP (first load can take a minute)...')
  const built = await buildArea(lat, lon, radiusKm, size, name)
  return {
    meta: built.meta,
    heights: built.heights,
    source: 'direct',
    textures: usgsTextures(built.bbox),
  }
}

/**
 * Re-open an area whose metadata we already have, without asking anything to
 * resolve it again. This is the path a reload with no signal takes: the
 * heightmap request is a GET the service worker can answer from cache.
 */
export async function reloadArea(meta: AreaMeta, caps: Capabilities | null): Promise<LoadedArea> {
  if (PREBAKE_BASE) {
    const pre = await loadPrebaked(PREBAKE_BASE, meta.lat, meta.lon, meta.radius_km, meta.size)
    if (pre) {
      return { meta: pre.meta, heights: pre.heights, source: 'prebake', textures: pre.textures }
    }
  }
  if (caps && !FORCE_DIRECT) {
    return {
      meta,
      heights: await api.fetchHeights(meta.id),
      source: 'backend',
      textures: {
        topo: api.textureUrl(meta.id, 'topo'),
        imagery: api.textureUrl(meta.id, 'imagery'),
      },
    }
  }
  const built = await buildArea(meta.lat, meta.lon, meta.radius_km, meta.size, meta.name)
  return {
    meta: built.meta,
    heights: built.heights,
    source: 'direct',
    textures: usgsTextures(built.bbox),
  }
}
