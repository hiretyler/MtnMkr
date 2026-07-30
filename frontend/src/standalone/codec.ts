import { gzipSync, gunzipSync } from 'fflate'
import type { AreaMeta } from '../types'

export interface EncodedHeights {
  encoding: 'q16.gz.b64' | 'q16.b64'
  data: string
}

/** btoa chokes on multi-MB spreads; build the binary string in 32 KB chunks. */
const B64_CHUNK = 32768

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += B64_CHUNK) {
    const sub = bytes.subarray(i, i + B64_CHUNK)
    binary += String.fromCharCode.apply(null, sub as unknown as number[])
  }
  return btoa(binary)
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/**
 * Quantize heights to 16-bit over [min, max], gzip, base64. Worst-case
 * error is (max - min) / 65535 / 2, about 3 cm over 2000 m of relief.
 */
export function encodeHeights(data: Float32Array, min: number, max: number): EncodedHeights {
  const range = max - min
  const q = new Uint16Array(data.length)
  if (range > 0) {
    for (let i = 0; i < data.length; i++) {
      const v = Math.round(((data[i] - min) / range) * 65535)
      q[i] = v < 0 ? 0 : v > 65535 ? 65535 : v
    }
  }
  const gz = gzipSync(new Uint8Array(q.buffer))
  return { encoding: 'q16.gz.b64', data: bytesToBase64(gz) }
}

export function decodeHeights(h: {
  encoding: 'q16.gz.b64' | 'q16.b64'
  min: number
  max: number
  width: number
  height: number
  data: string
}): Float32Array {
  let bytes = base64ToBytes(h.data)
  if (h.encoding === 'q16.gz.b64') bytes = gunzipSync(bytes)
  const q = new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 1)
  const n = h.width * h.height
  const range = h.max - h.min
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = h.min + (q[i] / 65535) * range
  return out
}

/**
 * Bilinear resample of a vertex-registered grid to target x target,
 * mirroring Heightfield.heightAt in geo.ts. Returns the inputs
 * unchanged if the source is already at or below the target size.
 */
export function downsampleHeightfield(
  meta: AreaMeta,
  data: Float32Array,
  target: number,
): { meta: AreaMeta; data: Float32Array } {
  const W = meta.width
  const H = meta.height
  if (target >= W && target >= H) return { meta, data }
  const sx = (W - 1) / (target - 1)
  const sy = (H - 1) / (target - 1)
  const out = new Float32Array(target * target)
  let min = Infinity
  let max = -Infinity
  for (let r = 0; r < target; r++) {
    const gy = r * sy
    const y0 = Math.floor(gy)
    const y1 = Math.min(y0 + 1, H - 1)
    const fy = gy - y0
    for (let c = 0; c < target; c++) {
      const gx = c * sx
      const x0 = Math.floor(gx)
      const x1 = Math.min(x0 + 1, W - 1)
      const fx = gx - x0
      const h00 = data[y0 * W + x0]
      const h10 = data[y0 * W + x1]
      const h01 = data[y1 * W + x0]
      const h11 = data[y1 * W + x1]
      const h =
        h00 * (1 - fx) * (1 - fy) +
        h10 * fx * (1 - fy) +
        h01 * (1 - fx) * fy +
        h11 * fx * fy
      out[r * target + c] = h
      if (h < min) min = h
      if (h > max) max = h
    }
  }
  return {
    meta: {
      ...meta,
      size: target,
      width: target,
      height: target,
      resolution_m: meta.resolution_m * ((W - 1) / (target - 1)),
      min_elev: min,
      max_elev: max,
    },
    data: out,
  }
}
