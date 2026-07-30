import * as THREE from 'three'
import { textureUrl } from './api'
import { buildTerrainGeometry, Heightfield, projectTrackSegment } from './geo'
import { makeSummitTexture, SUMMIT_ASPECT } from './pins'
import { downsampleHeightfield } from './standalone/codec'
import type { AreaMeta, BaseLayer, CustomLayer, Overlay } from './types'
import type { SummitInfo } from './viewer'

// AR Quick Look budget: USDA is stored-uncompressed ASCII, so geometry cost
// dominates. 320^2 verts is ~14 MB of text - detailed but AirDrop-friendly.
const GRID_TARGET = 320
const TEXTURE_SIZE = 2048
/** Tabletop footprint of the AR model, meters. */
const MODEL_SIZE_M = 0.35

const SHADED_BASE = '#b5b0a4'
const PIN_COLORS = { note: '#33638a', photo: '#7a4a21' } as const
// Same northwest sun as the live viewer's DirectionalLight
const SUN_DIR = new THREE.Vector3(-0.55, 1.0, -0.65).normalize()

/**
 * Bake a Lambert hillshade of the heightfield into ImageData. Needed
 * because USDZ carries no lights: without this the shaded-relief layer
 * would export as flat clay.
 */
function bakeHillshade(hf: Heightfield, exag: number): ImageData {
  const { width: W, height: H } = hf.meta
  const spacing = hf.meta.ground_size_m / (W - 1)
  const img = new ImageData(W, H)
  const base = new THREE.Color(SHADED_BASE)
  const n = new THREE.Vector3()
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      const i = r * W + c
      const cw = Math.max(c - 1, 0)
      const ce = Math.min(c + 1, W - 1)
      const rn = Math.max(r - 1, 0)
      const rs = Math.min(r + 1, H - 1)
      const dhdx = ((hf.data[r * W + ce] - hf.data[r * W + cw]) * exag) / ((ce - cw) * spacing)
      const dhdz = ((hf.data[rs * W + c] - hf.data[rn * W + c]) * exag) / ((rs - rn) * spacing)
      n.set(-dhdx, 1, -dhdz).normalize()
      const shade = 0.35 + 0.65 * Math.max(n.dot(SUN_DIR), 0)
      img.data[i * 4] = Math.round(base.r * 255 * shade)
      img.data[i * 4 + 1] = Math.round(base.g * 255 * shade)
      img.data[i * 4 + 2] = Math.round(base.b * 255 * shade)
      img.data[i * 4 + 3] = 255
    }
  }
  return img
}

/**
 * One canvas for the whole model: the draped layer (or a baked hillshade
 * on shaded relief), with GPS tracks drawn on top - Line2 fat lines can't
 * ride along into USDZ.
 */
async function bakeTexture(
  hfDs: Heightfield,
  fullHf: Heightfield,
  overlays: Overlay[],
  activeLayer: BaseLayer,
  customLayers: CustomLayer[],
  exag: number,
): Promise<HTMLCanvasElement> {
  const canvas = document.createElement('canvas')
  canvas.width = TEXTURE_SIZE
  canvas.height = TEXTURE_SIZE
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = SHADED_BASE
  ctx.fillRect(0, 0, TEXTURE_SIZE, TEXTURE_SIZE)

  if (activeLayer === 'shaded') {
    // Shade at up to 1024 grid and let drawImage smooth the upscale
    const sh = downsampleHeightfield(fullHf.meta, fullHf.data, Math.min(fullHf.meta.width, 1024))
    const shHf = new Heightfield(sh.meta, sh.data)
    const img = bakeHillshade(shHf, exag)
    const tmp = document.createElement('canvas')
    tmp.width = img.width
    tmp.height = img.height
    tmp.getContext('2d')!.putImageData(img, 0, 0)
    ctx.imageSmoothingEnabled = true
    ctx.drawImage(tmp, 0, 0, TEXTURE_SIZE, TEXTURE_SIZE)
  } else {
    const url =
      activeLayer === 'topo' || activeLayer === 'imagery'
        ? textureUrl(hfDs.meta.id, activeLayer, TEXTURE_SIZE)
        : customLayers.find((c) => `custom:${c.id}` === activeLayer)?.url
    if (!url) throw new Error('Active layer is not exportable')
    const res = await fetch(url)
    if (!res.ok) throw new Error(`Layer texture: fetch failed (${res.status})`)
    const bitmap = await createImageBitmap(await res.blob())
    ctx.drawImage(bitmap, 0, 0, TEXTURE_SIZE, TEXTURE_SIZE)
    bitmap.close()
  }

  // Tracks: scene xz -> texture pixels (row 0 = north, matching the UV
  // drape). Halo pass first so crossings stay legible.
  const half = hfDs.half
  const px = (v: number) => ((v + half) / (2 * half)) * TEXTURE_SIZE
  const runs: { color: string; pts: [number, number][] }[] = []
  for (const ov of overlays) {
    if (ov.kind !== 'track' || !ov.visible) continue
    for (const seg of ov.segments) {
      for (const run of projectTrackSegment(hfDs, seg, Infinity)) {
        if (run.length > 1) runs.push({ color: ov.color, pts: run })
      }
    }
  }
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  for (const pass of ['halo', 'color'] as const) {
    ctx.lineWidth = pass === 'halo' ? 7 : 4
    for (const { color, pts } of runs) {
      ctx.strokeStyle = pass === 'halo' ? '#f6f2e8' : color
      ctx.beginPath()
      ctx.moveTo(px(pts[0][0]), px(pts[0][1]))
      for (let i = 1; i < pts.length; i++) ctx.lineTo(px(pts[i][0]), px(pts[i][1]))
      ctx.stroke()
    }
  }
  return canvas
}

/**
 * Export the current terrain as a .usdz for iOS AR Quick Look - the one
 * share format iPhones open natively with no extra app. View-only: the
 * active layer is draped, tracks are baked into the texture, and pins
 * become small cone-and-sphere markers.
 */
export async function exportUsdz(opts: {
  meta: AreaMeta
  center: { lat: number; lon: number; name: string | null }
  /** viewer.hf.data, full resolution */
  heights: Float32Array
  overlays: Overlay[]
  activeLayer: BaseLayer
  customLayers: CustomLayer[]
  exaggeration: number
  summit: SummitInfo | null
}): Promise<void> {
  const exag = opts.exaggeration
  const fullHf = new Heightfield(opts.meta, opts.heights)
  const ds = downsampleHeightfield(opts.meta, opts.heights, GRID_TARGET)
  const hfDs = new Heightfield(ds.meta, ds.data)
  // Markers must sit on the exported (downsampled) surface, so all y math
  // uses the downsampled min_elev and heights
  const elevToY = (elev: number) => (elev - ds.meta.min_elev) * exag

  const disposables: { dispose(): void }[] = []
  const root = new THREE.Group()

  const canvas = await bakeTexture(
    hfDs,
    fullHf,
    opts.overlays,
    opts.activeLayer,
    opts.customLayers,
    exag,
  )
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  const terrainMat = new THREE.MeshStandardMaterial({ map: tex, roughness: 1, metalness: 0 })
  const terrainGeom = buildTerrainGeometry(hfDs, exag)
  disposables.push(tex, terrainMat, terrainGeom)
  root.add(new THREE.Mesh(terrainGeom, terrainMat))

  // Pin markers: shared unit geometries (cone tip at origin, base at y=1)
  // and one material per pin kind so the exporter dedupes
  const pinH = THREE.MathUtils.clamp(ds.meta.ground_size_m * 0.033, 30, 600)
  const stemGeom = new THREE.ConeGeometry(1, 1, 16)
  stemGeom.rotateX(Math.PI)
  stemGeom.translate(0, 0.5, 0)
  const headGeom = new THREE.SphereGeometry(1, 16, 12)
  const pinMats = {
    note: new THREE.MeshStandardMaterial({ color: PIN_COLORS.note, roughness: 0.6 }),
    photo: new THREE.MeshStandardMaterial({ color: PIN_COLORS.photo, roughness: 0.6 }),
  }
  disposables.push(stemGeom, headGeom, pinMats.note, pinMats.photo)

  for (const ov of opts.overlays) {
    if (ov.kind === 'track' || !ov.visible || ov.lon == null || ov.lat == null) continue
    const sc = hfDs.sceneFromLonLat(ov.lon, ov.lat)
    if (!sc) continue
    const [x, z] = sc
    const groundY = elevToY(hfDs.heightAt(x, z))
    const s = pinH * (ov.scale ?? 1)
    const mat = pinMats[ov.kind]
    const stem = new THREE.Mesh(stemGeom, mat)
    stem.scale.set(0.18 * s, 0.8 * s, 0.18 * s)
    stem.position.set(x, groundY, z)
    const head = new THREE.Mesh(headGeom, mat)
    head.scale.setScalar(0.28 * s)
    head.position.set(x, groundY + 0.85 * s, z)
    root.add(stem, head)
  }

  // Summit chip: the same canvas art as the in-app benchmark, on a pair of
  // opposed quads (the exporter warns on DoubleSide materials)
  if (opts.summit) {
    const sc = hfDs.sceneFromLonLat(opts.summit.lon, opts.summit.lat)
    if (sc) {
      const chipTex = makeSummitTexture(opts.summit.label, opts.summit.name)
      chipTex.colorSpace = THREE.SRGBColorSpace
      const chipMat = new THREE.MeshStandardMaterial({
        map: chipTex,
        alphaTest: 0.5,
        roughness: 1,
        metalness: 0,
      })
      const s = pinH * 0.85
      const front = new THREE.PlaneGeometry(s * SUMMIT_ASPECT, s)
      front.translate(0, s / 2, 0)
      const back = front.clone()
      back.rotateY(Math.PI)
      const uvs = back.getAttribute('uv') as THREE.BufferAttribute
      for (let i = 0; i < uvs.count; i++) uvs.setX(i, 1 - uvs.getX(i))
      disposables.push(chipTex, chipMat, front, back)
      const y = elevToY(opts.summit.elev)
      for (const geom of [front, back]) {
        const quad = new THREE.Mesh(geom, chipMat)
        quad.position.set(sc[0], y, sc[1])
        root.add(quad)
      }
    }
  }

  try {
    root.scale.setScalar(MODEL_SIZE_M / ds.meta.ground_size_m)
    root.updateMatrixWorld(true)
    const { USDZExporter } = await import('three/addons/exporters/USDZExporter.js')
    const bytes = await new USDZExporter().parseAsync(root, {
      maxTextureSize: TEXTURE_SIZE,
      quickLookCompatible: true,
    })

    const slug = (opts.center.name ?? 'mtnmkr-project').replace(/[^\w-]+/g, '-').toLowerCase()
    const blob = new Blob([bytes as BlobPart], { type: 'model/vnd.usdz+zip' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `${slug}.usdz`
    a.click()
    URL.revokeObjectURL(a.href)
  } finally {
    for (const d of disposables) d.dispose()
  }
}
