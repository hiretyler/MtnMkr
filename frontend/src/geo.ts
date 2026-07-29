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
   * Highest sample within radiusM of (lon, lat) - "the summit of the peak
   * at these coordinates", tolerant of small coordinate error without
   * jumping to a taller neighbor. Falls back to the area-wide high point
   * if the coordinates are outside the area.
   */
  localHighPoint(
    lon: number,
    lat: number,
    radiusM: number,
  ): { x: number; z: number; lon: number; lat: number; elev: number } {
    const sc = this.sceneFromLonLat(lon, lat)
    if (!sc) return this.highPoint()
    const { width: W, height: H } = this.meta
    const gx = Math.round(((sc[0] + this.half) / (2 * this.half)) * (W - 1))
    const gy = Math.round(((sc[1] + this.half) / (2 * this.half)) * (H - 1))
    const rx = Math.max(1, Math.ceil(radiusM / ((2 * this.half) / (W - 1))))
    const ry = Math.max(1, Math.ceil(radiusM / ((2 * this.half) / (H - 1))))
    let best = -1
    for (let r = Math.max(0, gy - ry); r <= Math.min(H - 1, gy + ry); r++) {
      for (let c = Math.max(0, gx - rx); c <= Math.min(W - 1, gx + rx); c++) {
        const i = r * W + c
        if (best < 0 || this.data[i] > this.data[best]) best = i
      }
    }
    return this.pointAt(best)
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
