/**
 * Pre-baked terrain: try a published static copy before asking USGS.
 *
 * 3DEP renders exports on demand, and how long that takes is theirs to decide
 * - measured between about 1 s and over 45 s for the same kind of request. A
 * pre-baked area is a plain file download, so the peaks people actually open
 * load in a predictable second or two.
 *
 * Built by backend/scripts/prebake_peaks.py. Because pre-baked areas are keyed
 * by the same id the API uses, a pre-baked peak, a client-built one, and a
 * server-built one are all the same cache entry.
 *
 * Heights arrive as uint16 with a min/scale in the metadata rather than raw
 * float32 - about half the bytes for a worst-case error near a centimetre,
 * which is well inside 3DEP's own vertical accuracy.
 */

import type { AreaMeta } from '../types'
import { areaId } from './usgs'

export interface PrebakePeak {
  name: string
  lat: number
  lon: number
  elev_m: number
}

/** One published tile. Nearby summits share a tile, so an area's centre is
 *  not necessarily any of its peaks. */
export interface PrebakeArea {
  name: string
  lat: number
  lon: number
  id: string
  radius_km: number
  size: number
  peaks: PrebakePeak[]
}

export interface PrebakeIndex {
  version: number
  size: number
  areas: PrebakeArea[]
}

interface HeightsEncoding {
  dtype: 'uint16'
  endian: 'little'
  min: number
  max: number
  scale: number
}

type PrebakedMeta = AreaMeta & { heights_encoding?: HeightsEncoding }

let indexCache: Promise<PrebakeIndex | null> | null = null

/** The published manifest, or null if this deploy has no pre-baked terrain. */
export function loadIndex(baseUrl: string): Promise<PrebakeIndex | null> {
  if (!indexCache) {
    indexCache = fetch(`${baseUrl}/index.json`)
      .then((r) => (r.ok ? (r.json() as Promise<PrebakeIndex>) : null))
      .catch(() => null)
  }
  return indexCache
}

/**
 * The baked area covering this summit, or null. Matched against each area's
 * member peaks rather than its centre, so a grouped tile answers for every
 * summit on it.
 */
export async function findBaked(
  baseUrl: string,
  lat: number,
  lon: number,
): Promise<PrebakeArea | null> {
  const idx = await loadIndex(baseUrl)
  if (!idx) return null
  // ~11 m: the peak list and the bake read the same gazetteer, so anything
  // beyond float formatting noise is a genuine miss.
  const EPS = 1e-4
  for (const area of idx.areas) {
    for (const p of area.peaks) {
      if (Math.abs(p.lat - lat) < EPS && Math.abs(p.lon - lon) < EPS) return area
    }
  }
  return null
}

async function decodeHeights(buf: ArrayBuffer, enc: HeightsEncoding): Promise<Float32Array> {
  // Same reasoning as the gazetteer: some hosts send Content-Encoding: gzip
  // for a .gz asset and the browser has already inflated it, others hand over
  // the raw bytes. Sniff rather than depend on the deploy.
  const head = new Uint8Array(buf.slice(0, 2))
  const bytes =
    head[0] === 0x1f && head[1] === 0x8b
      ? await new Response(
          new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip')),
        ).arrayBuffer()
      : buf

  const q = new Uint16Array(bytes)
  const out = new Float32Array(q.length)
  const { min, scale } = enc
  for (let i = 0; i < q.length; i++) out[i] = q[i] * scale + min
  return out
}

export interface PrebakedArea {
  meta: AreaMeta
  heights: Float32Array
  /** Texture URLs served from the pre-bake, not from USGS */
  textures: { topo: string; imagery: string }
}

/**
 * Fetch a pre-baked area, or null if this one was not published. Callers fall
 * back to building it live.
 */
export async function loadPrebaked(
  baseUrl: string,
  lat: number,
  lon: number,
  radiusKm: number,
  size: number,
): Promise<PrebakedArea | null> {
  const id = await areaId(lat, lon, radiusKm, size)
  const dir = `${baseUrl}/${id}`
  try {
    const metaRes = await fetch(`${dir}/meta.json`)
    if (!metaRes.ok) return null
    const meta = (await metaRes.json()) as PrebakedMeta
    const enc = meta.heights_encoding
    if (!enc || enc.dtype !== 'uint16') return null

    const hRes = await fetch(`${dir}/heights.u16.gz`)
    if (!hRes.ok) return null
    const heights = await decodeHeights(await hRes.arrayBuffer(), enc)
    if (heights.length !== meta.width * meta.height) return null

    return {
      meta,
      heights,
      textures: { topo: `${dir}/topo.png`, imagery: `${dir}/imagery.jpg` },
    }
  } catch {
    return null
  }
}
