/**
 * Terrain lighting bakes, off the main thread.
 *
 * Two single-channel maps over the DEM grid: a Lambertian hillshade with cast
 * shadows folded in, and a sky-view-factor ambient occlusion map. Both are
 * per-texel horizon searches over millions of texels, far past what a frame
 * budget allows - geo.ts's synchronous `buildHillshadeTexture` (no shadows)
 * is the fallback when a worker cannot be spawned.
 *
 * A third job bakes the same shadowed hillshade for the viewer's zoom-detail
 * patch: a finer DEM over a sub-window of the area, with the shadow march
 * continuing into the surrounding full-area grid when it walks off the patch
 * edge, so a ridge outside the window still casts into it.
 *
 * Both read true, unexaggerated elevations, for the same reason the geo.ts
 * bake does: like the hillshade printed on a map they encode the real
 * terrain, not the exaggeration slider.
 *
 * Grid conventions match the DEM: row 0 is the north edge, column 0 the west
 * edge, and output rows are flipped so texture v = 1 lands at north like the
 * terrain UVs. Azimuths are compass degrees (90 = east, 180 = south).
 */

export interface HillshadeJob {
  job: 'hillshade'
  jobId: number
  heights: Float32Array
  width: number
  height: number
  groundSize: number
  sunAz: number
  sunAlt: number
}

export interface AoJob {
  job: 'ao'
  jobId: number
  heights: Float32Array
  width: number
  height: number
  groundSize: number
}

export interface PatchHillshadeJob {
  job: 'patchHillshade'
  jobId: number
  /** The patch DEM, finer-grained than the base grid over the same window */
  heights: Float32Array
  width: number
  height: number
  groundSize: number
  sunAz: number
  sunAlt: number
  // The full-area grid the patch sits inside. The shadow march continues
  // into it past the patch edge - an occluder out there was only ever
  // resolved at base resolution anyway, so nothing sharper is available or
  // needed for it.
  baseHeights: Float32Array
  baseWidth: number
  baseHeight: number
  baseGroundSize: number
  /** Patch northwest corner, ground metres east of the base grid's */
  baseOffsetEast: number
  /** Patch northwest corner, ground metres south of the base grid's */
  baseOffsetSouth: number
}

export type LightingJob = HillshadeJob | AoJob | PatchHillshadeJob

export interface LightingResult {
  job: 'hillshade' | 'ao' | 'patchHillshade'
  jobId: number
  data: Uint8Array
  width: number
  height: number
}

// Half-width of the shadow's soft edge, in degrees of horizon-versus-sun
// difference. A hard cut aliases along the DEM's own stair steps; real
// terrain shadow edges are penumbral anyway, blurred by the sun's half-degree
// disc and by everything the grid resolution rounded off the ridge line.
const SHADOW_SOFT_DEG = 2.5

// The horizon march samples further apart the further out it gets: cost per
// texel then goes with the log of the search distance instead of its length,
// which is the difference between a two-second bake and a minute-long one. A
// ridge kilometres away subtends little enough that stepping over a cell of
// it cannot move the horizon by more than the soft edge absorbs.
const SHADOW_STEP_GROWTH = 1.06
// Ambient occlusion tolerates a much coarser search - it is a low-frequency
// term sampled over 8 directions, where each direction's error averages out.
const AO_STEP_GROWTH = 1.3
const AO_DIRECTIONS = 8
// Sky-view factor is baked at most this wide and linearly upsampled. Detail
// beyond it is invisible in a term this smooth, and the 8-direction search
// costs an order of magnitude more per texel than the hillshade's one.
const AO_MAX_SIDE = 1024

function maxOf(d: Float32Array): number {
  let m = -Infinity
  for (let i = 0; i < d.length; i++) {
    if (d[i] > m) m = d[i]
  }
  return m
}

/**
 * Box-average the DEM down to (aw x ah). Averaging rather than point
 * sampling: a lidar grid carries single-cell spikes, and a sky-view factor
 * built from picked samples would inherit them as isolated dark pixels.
 */
function downsample(
  d: Float32Array,
  w: number,
  h: number,
  aw: number,
  ah: number,
): Float32Array {
  if (aw === w && ah === h) return d
  const out = new Float32Array(aw * ah)
  for (let r = 0; r < ah; r++) {
    const r0 = Math.floor((r * h) / ah)
    const r1 = Math.max(r0 + 1, Math.floor(((r + 1) * h) / ah))
    for (let c = 0; c < aw; c++) {
      const c0 = Math.floor((c * w) / aw)
      const c1 = Math.max(c0 + 1, Math.floor(((c + 1) * w) / aw))
      let sum = 0
      let n = 0
      for (let rr = r0; rr < r1; rr++) {
        const row = rr * w
        for (let cc = c0; cc < c1; cc++) {
          sum += d[row + cc]
          n++
        }
      }
      out[r * aw + c] = sum / n
    }
  }
  return out
}

// The coarse full-area grid a patch bake's shadow march falls through to
// when it walks off the patch edge
interface ShadowSurround {
  d: Float32Array
  w: number
  h: number
  dx: number
  dy: number
  /** Primary grid's northwest corner, ground metres east of this grid's */
  offE: number
  /** Primary grid's northwest corner, ground metres south of this grid's */
  offS: number
  maxElev: number
}

/**
 * Lambertian hillshade with cast shadows over one grid. With a surround, a
 * march that exits the grid keeps walking through the surrounding coarse
 * grid instead of stopping - the base bake passes null and pays nothing for
 * the option.
 */
function shadeGrid(
  d: Float32Array,
  W: number,
  H: number,
  groundSize: number,
  sunAz: number,
  sunAlt: number,
  surround: ShadowSurround | null,
): Uint8Array {
  const dx = groundSize / (W - 1)
  const dy = groundSize / (H - 1)
  const az = (sunAz * Math.PI) / 180
  const alt = (sunAlt * Math.PI) / 180
  const sinAz = Math.sin(az)
  const cosAz = Math.cos(az)
  // Sun direction in (east, north, up)
  const lx = sinAz * Math.cos(alt)
  const ly = cosAz * Math.cos(alt)
  const lz = Math.sin(alt)
  // Grid steps per metre of ground distance walked toward the sun. Row index
  // grows southward, so a northward component walks to lower rows.
  const dcdt = sinAz / dx
  const drdt = -cosAz / dy
  const stepBase = Math.min(dx, dy)
  // Below the low tangent the texel is fully lit, above the high one fully
  // shadowed; only in between does the horizon angle need resolving
  const loTan = Math.tan(alt - (SHADOW_SOFT_DEG * Math.PI) / 180)
  const hiTan = Math.tan(Math.min(alt + (SHADOW_SOFT_DEG * Math.PI) / 180, 1.55))
  // With a surround the occluder search can reach its terrain too, so its
  // maximum bounds the headroom as well
  const maxElev = surround ? Math.max(maxOf(d), surround.maxElev) : maxOf(d)
  const cMax = W - 1
  const rMax = H - 1
  const sDcdt = surround ? sinAz / surround.dx : 0
  const sDrdt = surround ? -cosAz / surround.dy : 0
  const sCMax = surround ? surround.w - 1 : 0
  const sRMax = surround ? surround.h - 1 : 0

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
      if (nl <= 0) {
        // Facing away from the sun: already black, and no occluder can
        // darken it further
        out[outRow + c] = 0
        continue
      }

      const h = d[row + c]
      // Nothing beyond this distance can occlude: even the highest sample in
      // the whole grid would sit below the threshold horizon from here
      const headroom = maxElev - h
      let best = 0
      let thresh = loTan > 0 ? loTan : 0
      let step = stepBase
      let t = 0
      let cc = c
      let rr = r
      while (headroom > t * thresh) {
        t += step
        cc += dcdt * step
        rr += drdt * step
        if (cc < 0 || rr < 0 || cc > cMax || rr > rMax) break
        const slope = (d[((rr + 0.5) | 0) * W + ((cc + 0.5) | 0)] - h) / t
        if (slope > best) {
          best = slope
          if (best >= hiTan) break
          if (best > thresh) thresh = best
        }
        step *= SHADOW_STEP_GROWTH
      }

      // Out-of-bounds after the loop can only mean the bounds break fired -
      // the other exits leave the position inside - so pick the march back
      // up in the surrounding grid. The line never re-enters the patch (a
      // straight walk out of a rectangle stays out), so no double counting.
      if (surround !== null && best < hiTan && (cc < 0 || rr < 0 || cc > cMax || rr > rMax)) {
        // t metres along the sun's ground direction from texel (c, r),
        // re-expressed as fractional surround-grid indices
        let sc = (surround.offE + c * dx + sinAz * t) / surround.dx
        let sr = (surround.offS + r * dy - cosAz * t) / surround.dy
        while (headroom > t * thresh) {
          t += step
          sc += sDcdt * step
          sr += sDrdt * step
          if (sc < 0 || sr < 0 || sc > sCMax || sr > sRMax) break
          const slope = (surround.d[((sr + 0.5) | 0) * surround.w + ((sc + 0.5) | 0)] - h) / t
          if (slope > best) {
            best = slope
            if (best >= hiTan) break
            if (best > thresh) thresh = best
          }
          step *= SHADOW_STEP_GROWTH
        }
      }

      let shadow = 1
      if (best >= hiTan) {
        shadow = 0
      } else if (best > loTan) {
        const u =
          ((Math.atan(best) * 180) / Math.PI - (sunAlt - SHADOW_SOFT_DEG)) /
          (2 * SHADOW_SOFT_DEG)
        shadow = 1 - u * u * (3 - 2 * u)
      }
      out[outRow + c] = Math.round(nl * shadow * 255)
    }
  }
  return out
}

function bakeHillshade(job: HillshadeJob): LightingResult {
  const data = shadeGrid(
    job.heights,
    job.width,
    job.height,
    job.groundSize,
    job.sunAz,
    job.sunAlt,
    null,
  )
  return { job: 'hillshade', jobId: job.jobId, data, width: job.width, height: job.height }
}

function bakePatchHillshade(job: PatchHillshadeJob): LightingResult {
  const surround: ShadowSurround = {
    d: job.baseHeights,
    w: job.baseWidth,
    h: job.baseHeight,
    dx: job.baseGroundSize / (job.baseWidth - 1),
    dy: job.baseGroundSize / (job.baseHeight - 1),
    offE: job.baseOffsetEast,
    offS: job.baseOffsetSouth,
    maxElev: maxOf(job.baseHeights),
  }
  const data = shadeGrid(
    job.heights,
    job.width,
    job.height,
    job.groundSize,
    job.sunAz,
    job.sunAlt,
    surround,
  )
  return { job: 'patchHillshade', jobId: job.jobId, data, width: job.width, height: job.height }
}

/**
 * Sky-view factor: the fraction of the sky hemisphere a texel can see, as the
 * mean of cos^2(horizon) over evenly spaced azimuths. Flat open ground sees
 * every direction to the horizon and comes out at 1.0, a slot in a couloir
 * near 0. Independent of the sun, so the caller bakes it once per terrain.
 */
function bakeAo(job: AoJob): LightingResult {
  const W = Math.min(job.width, AO_MAX_SIDE)
  const H = Math.min(job.height, AO_MAX_SIDE)
  const d = downsample(job.heights, job.width, job.height, W, H)
  const dx = job.groundSize / (W - 1)
  const dy = job.groundSize / (H - 1)
  const dcdt = new Float64Array(AO_DIRECTIONS)
  const drdt = new Float64Array(AO_DIRECTIONS)
  for (let k = 0; k < AO_DIRECTIONS; k++) {
    const a = (2 * Math.PI * k) / AO_DIRECTIONS
    dcdt[k] = Math.sin(a) / dx
    drdt[k] = -Math.cos(a) / dy
  }
  const stepBase = Math.min(dx, dy)
  const maxElev = maxOf(d)
  const cMax = W - 1
  const rMax = H - 1

  const out = new Uint8Array(W * H)
  for (let r = 0; r < H; r++) {
    const row = r * W
    const outRow = (H - 1 - r) * W
    for (let c = 0; c < W; c++) {
      const h = d[row + c]
      const headroom = maxElev - h
      let svf = 0
      for (let k = 0; k < AO_DIRECTIONS; k++) {
        const kc = dcdt[k]
        const kr = drdt[k]
        let best = 0
        let step = stepBase
        let t = 0
        let cc = c
        let rr = r
        while (headroom > t * best) {
          t += step
          cc += kc * step
          rr += kr * step
          if (cc < 0 || rr < 0 || cc > cMax || rr > rMax) break
          const slope = (d[((rr + 0.5) | 0) * W + ((cc + 0.5) | 0)] - h) / t
          if (slope > best) best = slope
          step *= AO_STEP_GROWTH
        }
        // cos^2(atan(best)), without paying for the atan
        svf += 1 / (1 + best * best)
      }
      out[outRow + c] = Math.round((svf / AO_DIRECTIONS) * 255)
    }
  }
  return { job: 'ao', jobId: job.jobId, data: out, width: W, height: H }
}

export function runLightingJob(job: LightingJob): LightingResult {
  if (job.job === 'hillshade') return bakeHillshade(job)
  if (job.job === 'patchHillshade') return bakePatchHillshade(job)
  return bakeAo(job)
}

addEventListener('message', (e: MessageEvent<LightingJob>) => {
  const result = runLightingJob(e.data)
  // The result buffer is transferred, so nothing here holds it afterwards
  postMessage(result, { transfer: [result.data.buffer as ArrayBuffer] })
})
