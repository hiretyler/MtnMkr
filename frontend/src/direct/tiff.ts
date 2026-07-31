/**
 * Minimal float32 TIFF reader for the 3DEP ImageServer response.
 *
 * Deliberately not a general TIFF library. We control the request - it always
 * pins pixelType=F32 and format=tiff - and ArcGIS answers with one predictable
 * shape: classic little-endian TIFF, uncompressed, one 32-bit float sample per
 * pixel, in 128x128 tiles (256 of them for a 2048 grid). Handling exactly that
 * is ~60 lines; pulling in a full GeoTIFF library to do it would add several
 * hundred kB to a bundle that is already large.
 *
 * It refuses anything outside that shape rather than guessing, so if USGS ever
 * starts returning compressed tiles the failure is loud instead of silent
 * garbage terrain.
 */

const TAG = {
  imageWidth: 256,
  imageLength: 257,
  bitsPerSample: 258,
  compression: 259,
  stripOffsets: 273,
  samplesPerPixel: 277,
  rowsPerStrip: 278,
  stripByteCounts: 279,
  tileWidth: 322,
  tileLength: 323,
  tileOffsets: 324,
  tileByteCounts: 325,
  sampleFormat: 339,
} as const

// TIFF field type -> byte width
const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 11: 4, 12: 8 }

interface Field {
  type: number
  count: number
  values: number[]
}

function readFields(dv: DataView, le: boolean, ifdOffset: number): Map<number, Field> {
  const out = new Map<number, Field>()
  const n = dv.getUint16(ifdOffset, le)
  for (let i = 0; i < n; i++) {
    const off = ifdOffset + 2 + i * 12
    const tag = dv.getUint16(off, le)
    const type = dv.getUint16(off + 2, le)
    const count = dv.getUint32(off + 4, le)
    const size = TYPE_SIZE[type] ?? 0
    if (!size) continue
    const total = size * count
    // Values up to 4 bytes live inline; anything larger is a pointer
    const base = total <= 4 ? off + 8 : dv.getUint32(off + 8, le)
    const values: number[] = []
    for (let k = 0; k < count; k++) {
      const p = base + k * size
      if (type === 3) values.push(dv.getUint16(p, le))
      else if (type === 4) values.push(dv.getUint32(p, le))
      else if (type === 1 || type === 2) values.push(dv.getUint8(p))
      else if (type === 12) values.push(dv.getFloat64(p, le))
      else if (type === 11) values.push(dv.getFloat32(p, le))
      else values.push(0)
    }
    out.set(tag, { type, count, values })
  }
  return out
}

export interface DecodedRaster {
  width: number
  height: number
  data: Float32Array
}

export function decodeFloat32Tiff(buffer: ArrayBuffer): DecodedRaster {
  const dv = new DataView(buffer)
  const bo = dv.getUint16(0, false)
  if (bo !== 0x4949 && bo !== 0x4d4d) throw new Error('Not a TIFF (bad byte order mark)')
  const le = bo === 0x4949
  if (dv.getUint16(2, le) !== 42) throw new Error('Not a classic TIFF')

  const f = readFields(dv, le, dv.getUint32(4, le))
  const one = (tag: number, fallback?: number): number => {
    const v = f.get(tag)?.values[0]
    if (v === undefined) {
      if (fallback !== undefined) return fallback
      throw new Error(`TIFF is missing tag ${tag}`)
    }
    return v
  }

  const width = one(TAG.imageWidth)
  const height = one(TAG.imageLength)
  if (one(TAG.compression, 1) !== 1) throw new Error('Compressed TIFF is not supported')
  if (one(TAG.bitsPerSample) !== 32 || one(TAG.sampleFormat, 1) !== 3) {
    throw new Error('Expected 32-bit float samples')
  }
  if (one(TAG.samplesPerPixel, 1) !== 1) throw new Error('Expected a single band')

  // A typed-array view needs a 4-byte-aligned offset into the buffer, and
  // TIFF tile offsets have no such guarantee (3DEP's first tile lands at
  // 1146). Slicing copies the run into a fresh, aligned buffer - one memcpy
  // per tile, negligible next to the network fetch.
  //
  // Float32Array also reads in platform byte order, which is little-endian
  // everywhere this runs; a big-endian TIFF would need byte swapping, so
  // reject it rather than silently produce nonsense.
  if (!le) throw new Error('Big-endian TIFF is not supported')
  const floatsAt = (offset: number, count: number): Float32Array =>
    new Float32Array(buffer.slice(offset, offset + count * 4))

  const out = new Float32Array(width * height)

  const tileW = f.get(TAG.tileWidth)?.values[0]
  const tileH = f.get(TAG.tileLength)?.values[0]
  if (tileW && tileH) {
    // Tiled: tiles run left-to-right, top-to-bottom, and the last column and
    // row are padded out to a full tile, so the edges have to be clipped.
    const offsets = f.get(TAG.tileOffsets)?.values ?? []
    const across = Math.ceil(width / tileW)
    const down = Math.ceil(height / tileH)
    if (offsets.length < across * down) throw new Error('TIFF tile table is short')
    for (let ty = 0; ty < down; ty++) {
      for (let tx = 0; tx < across; tx++) {
        const src = floatsAt(offsets[ty * across + tx], tileW * tileH)
        const rows = Math.min(tileH, height - ty * tileH)
        const cols = Math.min(tileW, width - tx * tileW)
        for (let r = 0; r < rows; r++) {
          const from = r * tileW
          out.set(src.subarray(from, from + cols), (ty * tileH + r) * width + tx * tileW)
        }
      }
    }
    return { width, height, data: out }
  }

  // Stripped fallback - not what 3DEP currently returns, but cheap to support
  const stripOffsets = f.get(TAG.stripOffsets)?.values
  if (!stripOffsets) throw new Error('TIFF has neither tiles nor strips')
  const rowsPerStrip = one(TAG.rowsPerStrip, height)
  for (let s = 0; s < stripOffsets.length; s++) {
    const firstRow = s * rowsPerStrip
    const rows = Math.min(rowsPerStrip, height - firstRow)
    if (rows <= 0) break
    const src = floatsAt(stripOffsets[s], rows * width)
    out.set(src, firstRow * width)
  }
  return { width, height, data: out }
}
