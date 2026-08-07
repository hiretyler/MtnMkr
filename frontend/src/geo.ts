import * as THREE from 'three'
import type { AreaMeta } from './types'

const R = 6378137

export function lonLatToMerc(lon: number, lat: number): [number, number] {
  const x = (lon * Math.PI) / 180 * R
  const y = R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 180 / 2))
  return [x, y]
}

export function mercToLonLat(x: number, y: number): [number, number] {
  const lon = (x / R) * (180 / Math.PI)
  const lat = ((2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * 180) / Math.PI
  return [lon, lat]
}

/**
 * The loaded DEM plus the mapping between geography and scene space.
 *
 * Scene space: x = east (true meters), y = up (meters, before exaggeration),
 * z = south. Origin is the area center at elevation 0. Heightmap row 0 is
 * the north edge.
 */
export class Heightfield {
  readonly half: number
  private cachedHigh: { x: number; z: number; lon: number; lat: number; elev: number } | null =
    null

  constructor(
    readonly meta: AreaMeta,
    readonly data: Float32Array,
  ) {
    this.half = meta.ground_size_m / 2
  }

  private pointAt(i: number): { x: number; z: number; lon: number; lat: number; elev: number } {
    const { width: W, height: H } = this.meta
    const r = Math.floor(i / W)
    const c = i % W
    const x = -this.half + (c / (W - 1)) * 2 * this.half
    const z = -this.half + (r / (H - 1)) * 2 * this.half
    const [lon, lat] = this.lonLatFromScene(x, z)
    return { x, z, lon, lat, elev: this.data[i] }
  }

  /** The DEM's highest sample - the high point of the whole modeled area. */
  highPoint(): { x: number; z: number; lon: number; lat: number; elev: number } {
    if (!this.cachedHigh) {
      let best = 0
      for (let i = 1; i < this.data.length; i++) {
        if (this.data[i] > this.data[best]) best = i
      }
      this.cachedHigh = this.pointAt(best)
    }
    return this.cachedHigh
  }

  /**
   * The summit of the peak at (lon, lat): greedy hill-climb until no
   * higher cell exists within a 2-cell neighborhood. Unlike a fixed
   * search window, this cannot jump to a taller neighbor - reaching one
   * would require descending through the connecting saddle first (The
   * Prow sits 151 m from Kit Carson Peak; a window search marked Kit
   * Carson). The 2-cell look-ahead steps over micro-bumps in lidar
   * grids without crossing real notches. Falls back to the area-wide
   * high point if the coordinates are outside the area.
   */
  summitFrom(
    lon: number,
    lat: number,
  ): { x: number; z: number; lon: number; lat: number; elev: number } {
    const sc = this.sceneFromLonLat(lon, lat)
    if (!sc) return this.highPoint()
    const { width: W, height: H } = this.meta
    let gx = Math.round(((sc[0] + this.half) / (2 * this.half)) * (W - 1))
    let gy = Math.round(((sc[1] + this.half) / (2 * this.half)) * (H - 1))
    let cur = gy * W + gx
    for (let iter = 0; iter < 5000; iter++) {
      let best = cur
      for (let dy = -2; dy <= 2; dy++) {
        const r = gy + dy
        if (r < 0 || r >= H) continue
        for (let dx = -2; dx <= 2; dx++) {
          const c = gx + dx
          if (c < 0 || c >= W) continue
          const i = r * W + c
          if (this.data[i] > this.data[best]) best = i
        }
      }
      if (best === cur) break
      cur = best
      gy = Math.floor(cur / W)
      gx = cur % W
    }
    return this.pointAt(cur)
  }

  sceneFromLonLat(lon: number, lat: number): [number, number] | null {
    const [mx, my] = lonLatToMerc(lon, lat)
    const [xmin, ymin, xmax, ymax] = this.meta.bbox3857
    const tx = (mx - xmin) / (xmax - xmin)
    const ty = (ymax - my) / (ymax - ymin)
    if (tx < 0 || tx > 1 || ty < 0 || ty > 1) return null
    return [-this.half + tx * 2 * this.half, -this.half + ty * 2 * this.half]
  }

  lonLatFromScene(x: number, z: number): [number, number] {
    const [xmin, ymin, xmax, ymax] = this.meta.bbox3857
    const tx = (x + this.half) / (2 * this.half)
    const ty = (z + this.half) / (2 * this.half)
    return mercToLonLat(xmin + tx * (xmax - xmin), ymax - ty * (ymax - ymin))
  }

  /** Bilinear elevation sample at scene coordinates (meters). */
  heightAt(x: number, z: number): number {
    const { width: W, height: H } = this.meta
    const gx = THREE.MathUtils.clamp(((x + this.half) / (2 * this.half)) * (W - 1), 0, W - 1)
    const gy = THREE.MathUtils.clamp(((z + this.half) / (2 * this.half)) * (H - 1), 0, H - 1)
    const x0 = Math.floor(gx)
    const y0 = Math.floor(gy)
    const x1 = Math.min(x0 + 1, W - 1)
    const y1 = Math.min(y0 + 1, H - 1)
    const fx = gx - x0
    const fy = gy - y0
    const d = this.data
    const h00 = d[y0 * W + x0]
    const h10 = d[y0 * W + x1]
    const h01 = d[y1 * W + x0]
    const h11 = d[y1 * W + x1]
    return (
      h00 * (1 - fx) * (1 - fy) +
      h10 * fx * (1 - fy) +
      h01 * (1 - fx) * fy +
      h11 * fx * fy
    )
  }

  /**
   * Raymarch the heightfield. Scene y for elevation h is (h - base) * exag.
   * Returns the hit point in scene space or null. Much faster than mesh
   * raycasting at 2M triangles.
   */
  raycast(ray: THREE.Ray, exag: number, base = 0): THREE.Vector3 | null {
    const o = ray.origin
    const dir = ray.direction
    const half = this.half

    // Slab test against the horizontal extents
    let tMin = 0
    let tMax = Infinity
    for (const [oc, dc] of [
      [o.x, dir.x],
      [o.z, dir.z],
    ] as const) {
      if (Math.abs(dc) < 1e-12) {
        if (oc < -half || oc > half) return null
      } else {
        let t0 = (-half - oc) / dc
        let t1 = (half - oc) / dc
        if (t0 > t1) [t0, t1] = [t1, t0]
        tMin = Math.max(tMin, t0)
        tMax = Math.min(tMax, t1)
        if (tMin > tMax) return null
      }
    }

    const maxY = (this.meta.max_elev - base) * exag
    // Skip ahead to where the ray first drops below the terrain ceiling
    if (o.y + dir.y * tMin > maxY) {
      if (dir.y >= 0) return null
      tMin = Math.max(tMin, (maxY - o.y) / dir.y)
    }

    // A near-vertical ray defeats the horizontal slab test - tMax comes out
    // astronomical, or Infinity when both horizontal components are ~0 - and
    // an upward one never intersects, so the march must be capped to the
    // longest path that can actually cross the box or it spins forever.
    tMax = Math.min(
      tMax,
      tMin + 8 * half + (this.meta.max_elev - this.meta.min_elev) * Math.max(exag, 1),
    )

    const step = Math.max(this.meta.resolution_m, (2 * half) / 2000)
    const p = new THREE.Vector3()
    let tPrev = tMin
    let prevAbove = true
    const yOf = (x: number, z: number) => (this.heightAt(x, z) - base) * exag
    for (let t = tMin; t <= tMax; t += step) {
      p.copy(o).addScaledVector(dir, t)
      if (p.y <= yOf(p.x, p.z)) {
        if (prevAbove) {
          // Bisect between tPrev and t
          let lo = tPrev
          let hi = t
          for (let i = 0; i < 16; i++) {
            const mid = (lo + hi) / 2
            p.copy(o).addScaledVector(dir, mid)
            if (p.y <= yOf(p.x, p.z)) hi = mid
            else lo = mid
          }
          p.copy(o).addScaledVector(dir, hi)
        }
        p.y = yOf(p.x, p.z)
        return p.clone()
      }
      tPrev = t
      prevAbove = true
    }
    return null
  }
}

/**
 * Build the terrain mesh geometry for a heightfield: an indexed grid over
 * ±half with heights baked into y as (h - min_elev) * exag and UVs mapping
 * row 0 to the top of the draped texture.
 */
export function buildTerrainGeometry(hf: Heightfield, exag: number): THREE.BufferGeometry {
  const { width: W, height: H, min_elev } = hf.meta
  const half = hf.half
  const pos = new Float32Array(W * H * 3)
  const uv = new Float32Array(W * H * 2)
  for (let r = 0; r < H; r++) {
    const z = -half + (r / (H - 1)) * 2 * half
    for (let c = 0; c < W; c++) {
      const i = r * W + c
      pos[i * 3] = -half + (c / (W - 1)) * 2 * half
      pos[i * 3 + 1] = (hf.data[i] - min_elev) * exag
      pos[i * 3 + 2] = z
      uv[i * 2] = c / (W - 1)
      uv[i * 2 + 1] = 1 - r / (H - 1)
    }
  }
  const index = new Uint32Array((W - 1) * (H - 1) * 6)
  let k = 0
  for (let r = 0; r < H - 1; r++) {
    for (let c = 0; c < W - 1; c++) {
      const a = r * W + c
      const b = a + 1
      const d = a + W
      const e = d + 1
      index[k++] = a
      index[k++] = d
      index[k++] = b
      index[k++] = b
      index[k++] = d
      index[k++] = e
    }
  }
  const geom = new THREE.BufferGeometry()
  geom.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  geom.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
  geom.setIndex(new THREE.BufferAttribute(index, 1))
  geom.computeVertexNormals()
  return geom
}

/**
 * Lambertian hillshade of the heightfield as a single-channel texture, lit
 * from azimuth 315 deg at 45 deg altitude - the same northwest-sun
 * convention as the scene lighting. Computed from true (unexaggerated)
 * elevations: like the hillshade printed on a map it encodes the real
 * terrain, so it deliberately does not track the exaggeration slider - the
 * scene lighting already conveys exaggerated relief, and recomputing a
 * full-grid pass on every slider tick would buy nothing.
 * Rows are flipped so texture v matches the terrain UVs (v = 1 at north).
 */
export function buildHillshadeTexture(hf: Heightfield): THREE.DataTexture {
  const { width: W, height: H } = hf.meta
  const d = hf.data
  const dx = hf.meta.ground_size_m / (W - 1)
  const dy = hf.meta.ground_size_m / (H - 1)
  // Sun direction in (east, north, up)
  const lx = -0.5
  const ly = 0.5
  const lz = Math.SQRT1_2
  const out = new Uint8Array(W * H)
  for (let r = 0; r < H; r++) {
    const rN = Math.max(r - 1, 0)
    const rS = Math.min(r + 1, H - 1)
    const row = r * W
    const outRow = (H - 1 - r) * W
    for (let c = 0; c < W; c++) {
      const cW = Math.max(c - 1, 0)
      const cE = Math.min(c + 1, W - 1)
      const dzde = (d[row + cE] - d[row + cW]) / ((cE - cW) * dx)
      // Row index grows southward, so the northern neighbor is the lower row
      const dzdn = (d[rN * W + c] - d[rS * W + c]) / ((rS - rN) * dy)
      // Surface normal is (-dzde, -dzdn, 1) before normalization
      const nl = (-dzde * lx - dzdn * ly + lz) / Math.sqrt(dzde * dzde + dzdn * dzdn + 1)
      out[outRow + c] = nl > 0 ? Math.round(nl * 255) : 0
    }
  }
  const tex = new THREE.DataTexture(out, W, H, THREE.RedFormat, THREE.UnsignedByteType)
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.magFilter = THREE.LinearFilter
  tex.generateMipmaps = true
  // Single-byte rows are not 4-byte aligned at every width
  tex.unpackAlignment = 1
  tex.needsUpdate = true
  return tex
}

/**
 * Project a lon/lat segment into scene space, splitting where it leaves
 * the area and subdividing long spans so lines drape onto the terrain.
 */
export function projectTrackSegment(
  hf: Heightfield,
  seg: [number, number, number | null][],
  maxSeg: number,
): [number, number][][] {
  const runs: [number, number][][] = []
  let current: [number, number][] = []
  let prev: [number, number] | null = null
  for (const [lon, lat] of seg) {
    const sc = hf.sceneFromLonLat(lon, lat)
    if (!sc) {
      if (current.length > 1) runs.push(current)
      current = []
      prev = null
      continue
    }
    if (prev) {
      const dx = sc[0] - prev[0]
      const dz = sc[1] - prev[1]
      const dist = Math.hypot(dx, dz)
      const n = Math.floor(dist / maxSeg)
      for (let i = 1; i <= n; i++) {
        current.push([prev[0] + (dx * i) / (n + 1), prev[1] + (dz * i) / (n + 1)])
      }
    }
    current.push(sc)
    prev = sc
  }
  if (current.length > 1) runs.push(current)
  return runs
}

export function formatDMS(lat: number, lon: number): string {
  const f = (v: number, pos: string, neg: string) => {
    const hemi = v >= 0 ? pos : neg
    const a = Math.abs(v)
    const d = Math.floor(a)
    const m = Math.floor((a - d) * 60)
    const s = Math.round(((a - d) * 60 - m) * 60)
    return `${d}°${String(m).padStart(2, '0')}'${String(s).padStart(2, '0')}" ${hemi}`
  }
  return `${f(lat, 'N', 'S')}  ${f(lon, 'E', 'W')}`
}

/**
 * Parse a coordinate pair the way people actually paste them.
 *
 * Phones and map apps all disagree on format, and someone standing on a
 * ridge reading numbers off a compass app should not have to convert
 * anything. Accepts decimal ("40.2548, -105.6162"), degrees-minutes-seconds
 * ("40°15'17\"N 105°36'58\"W"), and degrees-decimal-minutes ("40°15.28'N
 * 105 36.97 W"), with or without symbols, hemisphere letters on either
 * side, and comma or whitespace separators.
 *
 * Returns null rather than guessing when the input is ambiguous or out of
 * range. Latitude is clamped to +-90 by validation, not by silently wrapping.
 */
export function parseLatLon(input: string): { lat: number; lon: number } | null {
  // Normalise the punctuation zoo: typographic quotes, prime marks, the
  // masculine ordinal that some keyboards produce instead of a degree sign.
  const s = input
    .trim()
    .toUpperCase()
    .replace(/[º°˚]/g, '°')
    .replace(/[′’`´]/g, "'")
    .replace(/[″”“]/g, '"')
    .replace(/\s+/g, ' ')

  // One component: optional sign, degrees, optional minutes, optional
  // seconds, optional hemisphere letter (which may also lead).
  const COMP =
    "([NSEW])?\\s*([+-]?\\d+(?:\\.\\d+)?)\\s*(?:°|D)?\\s*" +
    "(?:(\\d+(?:\\.\\d+)?)\\s*(?:'|M)?\\s*" +
    "(?:(\\d+(?:\\.\\d+)?)\\s*(?:\"|S)?)?)?\\s*([NSEW])?"
  const m = s.match(new RegExp(`^${COMP}\\s*[, ]\\s*${COMP}$`))
  if (!m) return null

  const comp = (
    pre: string | undefined,
    deg: string,
    min: string | undefined,
    sec: string | undefined,
    post: string | undefined,
  ): { val: number; hemi: string | null } | null => {
    const hemi = post || pre || null
    if (pre && post) return null // "N40N" is not a thing
    const d = parseFloat(deg)
    if (!isFinite(d)) return null
    // A signed value with a hemisphere letter is contradictory input
    if (hemi && /^[+-]/.test(deg)) return null
    let val = Math.abs(d) + (min ? parseFloat(min) / 60 : 0) + (sec ? parseFloat(sec) / 3600 : 0)
    if (min !== undefined && parseFloat(min) >= 60) return null
    if (sec !== undefined && parseFloat(sec) >= 60) return null
    if (d < 0) val = -val
    return { val, hemi }
  }

  const a = comp(m[1], m[2], m[3], m[4], m[5])
  const b = comp(m[6], m[7], m[8], m[9], m[10])
  if (!a || !b) return null

  const apply = (c: { val: number; hemi: string | null }): number =>
    c.hemi === 'S' || c.hemi === 'W' ? -Math.abs(c.val) : c.val

  let lat: number
  let lon: number
  const aIsLon = a.hemi === 'E' || a.hemi === 'W'
  const bIsLat = b.hemi === 'N' || b.hemi === 'S'
  if (aIsLon || bIsLat) {
    // Written lon-first ("105W 40N"); rare, but unambiguous when labelled
    lon = apply(a)
    lat = apply(b)
  } else {
    lat = apply(a)
    lon = apply(b)
  }

  if (!isFinite(lat) || !isFinite(lon)) return null
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null
  return { lat, lon }
}

/** Great-circle distance in km between two lon/lat points. */
export function distanceKm(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const dLat = ((lat2 - lat1) * Math.PI) / 180
  const dLon = ((lon2 - lon1) * Math.PI) / 180
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2
  return (2 * R * Math.asin(Math.sqrt(a))) / 1000
}

/** Initial true bearing in degrees (0 = north) from point 1 to point 2. */
export function bearingDeg(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const p1 = (lat1 * Math.PI) / 180
  const p2 = (lat2 * Math.PI) / 180
  const dl = ((lon2 - lon1) * Math.PI) / 180
  const y = Math.sin(dl) * Math.cos(p2)
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl)
  return (((Math.atan2(y, x) * 180) / Math.PI) + 360) % 360
}

const COMPASS_POINTS = [
  'N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
  'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW',
]

/** Bearing as a 16-point compass label ("NNE"). */
export function compassPoint(deg: number): string {
  return COMPASS_POINTS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16]
}

export function trackLengthKm(segments: [number, number, number | null][][]): number {
  let total = 0
  for (const seg of segments) {
    for (let i = 1; i < seg.length; i++) {
      const [lon1, lat1] = seg[i - 1]
      const [lon2, lat2] = seg[i]
      const dLat = ((lat2 - lat1) * Math.PI) / 180
      const dLon = ((lon2 - lon1) * Math.PI) / 180
      const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos((lat1 * Math.PI) / 180) *
          Math.cos((lat2 * Math.PI) / 180) *
          Math.sin(dLon / 2) ** 2
      total += 2 * R * Math.asin(Math.sqrt(a))
    }
  }
  return total / 1000
}
