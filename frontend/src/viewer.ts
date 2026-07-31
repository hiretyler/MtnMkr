import * as THREE from 'three'
import { MapControls } from 'three/addons/controls/MapControls.js'
import { Line2 } from 'three/addons/lines/Line2.js'
import { LineGeometry } from 'three/addons/lines/LineGeometry.js'
import { LineMaterial } from 'three/addons/lines/LineMaterial.js'
import { buildTerrainGeometry, Heightfield, projectTrackSegment } from './geo'
import {
  makeNotePinTexture,
  makePhotoPinTexture,
  makeSummitTexture,
  PIN_ASPECT,
  SUMMIT_ASPECT,
} from './pins'
import type { AreaMeta, Overlay } from './types'

export interface SummitInfo {
  lon: number
  lat: number
  elev: number
  label: string
  /** Peak name shown above the elevation, when the load was a named peak */
  name?: string | null
}

export interface ViewerEvents {
  /** A click landed on bare terrain. */
  onPickTerrain(lon: number, lat: number, elev: number): void
  /** A pin was clicked (id) or the sky/nothing was clicked (null). */
  onSelectOverlay(id: string | null): void
  /**
   * Camera azimuth changed. The value is the compass-rose rotation in CSS
   * degrees: rotate the rose by this much and its north needle points at
   * true north on screen. Fired from the render loop, throttled to real
   * changes - update the DOM directly, not through React state.
   */
  onHeadingChange(roseDeg: number): void
}

const SHADED_COLOR = 0xb5b0a4
const FOG_COLOR = 0xc9cfc4

export class Viewer {
  private renderer: THREE.WebGLRenderer
  private scene = new THREE.Scene()
  private camera: THREE.PerspectiveCamera
  private controls: MapControls
  private terrain: THREE.Mesh | null = null
  private material: THREE.MeshStandardMaterial
  private overlayGroup = new THREE.Group()
  private pinSprites: THREE.Sprite[] = []
  private lineMaterials: LineMaterial[] = []
  private pinTextures = new Map<string, THREE.CanvasTexture>()
  private notePinTexture: THREE.CanvasTexture
  private summitTexture: THREE.CanvasTexture | null = null
  private summit: SummitInfo | null = null
  private raycaster = new THREE.Raycaster()
  private resizeObserver: ResizeObserver
  private textureToken = 0

  private hfInternal: Heightfield | null = null
  private exag = 1
  private lastOverlays: Overlay[] = []
  private lastSelected: string | null = null

  private pointerDown: { x: number; y: number; button: number } | null = null
  private camAnim: {
    fromPos: THREE.Vector3
    toPos: THREE.Vector3
    start: number
    dur: number
  } | null = null
  private northAnim: {
    fromTheta: number
    radius: number
    phi: number
    start: number
    dur: number
  } | null = null
  private lastRoseDeg = Infinity

  constructor(
    private canvas: HTMLCanvasElement,
    private events: ViewerEvents,
  ) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.05

    this.camera = new THREE.PerspectiveCamera(55, 1, 1, 1e7)
    this.camera.position.set(2000, 2000, 3000)

    const hemi = new THREE.HemisphereLight(0xe8f0f7, 0x8a7f6a, 0.85)
    this.scene.add(hemi)
    // Cartographic convention: relief lit from the northwest
    const sun = new THREE.DirectionalLight(0xfff2de, 2.0)
    sun.position.set(-0.55, 1.0, -0.65)
    this.scene.add(sun)
    this.scene.add(this.overlayGroup)

    this.material = new THREE.MeshStandardMaterial({
      color: SHADED_COLOR,
      roughness: 1,
      metalness: 0,
    })

    this.controls = new MapControls(this.camera, canvas)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.12
    this.controls.maxPolarAngle = Math.PI * 0.49
    this.controls.screenSpacePanning = false

    this.notePinTexture = makeNotePinTexture()

    canvas.addEventListener('pointerdown', this.onPointerDown)
    canvas.addEventListener('pointerup', this.onPointerUp)

    this.resizeObserver = new ResizeObserver(() => this.resize())
    this.resizeObserver.observe(canvas.parentElement ?? canvas)
    this.resize()

    this.renderer.setAnimationLoop(this.tick)
  }

  get hf(): Heightfield | null {
    return this.hfInternal
  }

  get exaggeration(): number {
    return this.exag
  }

  get summitInfo(): SummitInfo | null {
    return this.summit
  }

  private elevToY(elev: number): number {
    const base = this.hfInternal?.meta.min_elev ?? 0
    return (elev - base) * this.exag
  }

  // ---- terrain ----------------------------------------------------------

  setTerrain(meta: AreaMeta, heights: Float32Array): void {
    if (this.terrain) {
      this.scene.remove(this.terrain)
      this.terrain.geometry.dispose()
    }
    this.hfInternal = new Heightfield(meta, heights)

    const geom = buildTerrainGeometry(this.hfInternal, this.exag)
    this.terrain = new THREE.Mesh(geom, this.material)
    this.scene.add(this.terrain)

    const size = meta.ground_size_m
    this.scene.fog = new THREE.Fog(FOG_COLOR, size * 2.5, size * 9)
    this.camera.near = Math.max(1, size / 2000)
    this.camera.far = size * 30
    this.camera.updateProjectionMatrix()

    const relief = (meta.max_elev - meta.min_elev) * this.exag
    const target = new THREE.Vector3(0, relief * 0.35, 0)
    const camPos = new THREE.Vector3(size * 0.42, relief * 0.85 + size * 0.28, size * 0.72)
    this.controls.target.copy(target)
    this.controls.minDistance = size * 0.02
    this.controls.maxDistance = size * 4

    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (reduceMotion) {
      this.camera.position.copy(camPos)
      this.camAnim = null
    } else {
      const fromPos = camPos.clone().sub(target).multiplyScalar(2.4).add(target)
      fromPos.y += size * 0.15
      this.camera.position.copy(fromPos)
      this.camAnim = {
        fromPos,
        toPos: camPos,
        start: performance.now(),
        dur: 1400,
      }
    }
    this.controls.update()
    this.renderOverlays()
  }

  setExaggeration(exag: number): void {
    this.exag = exag
    if (!this.terrain || !this.hfInternal) return
    const hf = this.hfInternal
    const posAttr = this.terrain.geometry.getAttribute('position') as THREE.BufferAttribute
    const arr = posAttr.array as Float32Array
    const minE = hf.meta.min_elev
    for (let i = 0; i < hf.data.length; i++) {
      arr[i * 3 + 1] = (hf.data[i] - minE) * exag
    }
    posAttr.needsUpdate = true
    this.terrain.geometry.computeVertexNormals()
    this.renderOverlays()
  }

  // ---- draped layers ----------------------------------------------------

  setShaded(): void {
    this.textureToken++
    if (this.material.map) {
      this.material.map.dispose()
      this.material.map = null
    }
    this.material.color.set(SHADED_COLOR)
    this.material.needsUpdate = true
  }

  async setTextureUrl(url: string): Promise<void> {
    const token = ++this.textureToken
    const tex = await new THREE.TextureLoader().loadAsync(url)
    if (token !== this.textureToken) {
      tex.dispose()
      return
    }
    tex.colorSpace = THREE.SRGBColorSpace
    tex.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy())
    if (this.material.map) this.material.map.dispose()
    this.material.map = tex
    this.material.color.set(0xffffff)
    this.material.needsUpdate = true
  }

  /**
   * Set (or update/clear) the summit benchmark. The caller decides where
   * the summit is - the peak the user asked for, not necessarily the
   * area's highest sample.
   */
  setSummit(info: SummitInfo | null): void {
    if (!info) {
      this.summit = null
      this.summitTexture?.dispose()
      this.summitTexture = null
    } else {
      if (
        !this.summit ||
        this.summit.label !== info.label ||
        this.summit.name !== info.name
      ) {
        this.summitTexture?.dispose()
        this.summitTexture = makeSummitTexture(info.label, info.name)
      }
      this.summit = info
    }
    this.renderOverlays()
  }

  // ---- overlays ---------------------------------------------------------

  setOverlays(overlays: Overlay[], selectedId: string | null): void {
    this.lastOverlays = overlays
    this.lastSelected = selectedId
    this.renderOverlays()
  }

  private clearOverlayGroup(): void {
    for (const child of [...this.overlayGroup.children]) {
      this.overlayGroup.remove(child)
      child.traverse((o) => {
        if (o instanceof THREE.Mesh || o instanceof Line2) {
          o.geometry?.dispose()
        }
        if (o instanceof THREE.Sprite) {
          o.material.dispose() // materials only - textures are cached separately
        }
      })
    }
    for (const m of this.lineMaterials) m.dispose()
    this.lineMaterials = []
    this.pinSprites = []
  }

  private renderOverlays(): void {
    this.clearOverlayGroup()
    const hf = this.hfInternal
    if (!hf) return

    const size = hf.meta.ground_size_m
    // Clearance scales with DEM resolution, not area size: just enough to
    // clear bilinear-vs-triangle interpolation differences without visibly
    // hovering. Subdivision at ~3 DEM cells keeps chords on the surface.
    const res = hf.meta.resolution_m
    const lift = THREE.MathUtils.clamp(1.5 * res, 1, 10)
    const maxSeg = THREE.MathUtils.clamp(3 * res, 6, 40)
    const pinH = THREE.MathUtils.clamp(size * 0.033, 30, 600)

    const liveIds = new Set(this.lastOverlays.map((o) => o.id))
    for (const [id, tex] of this.pinTextures) {
      if (!liveIds.has(id)) {
        tex.dispose()
        this.pinTextures.delete(id)
      }
    }

    if (this.summit && this.summitTexture) {
      const sc = hf.sceneFromLonLat(this.summit.lon, this.summit.lat)
      if (sc) {
        const sprite = new THREE.Sprite(
          new THREE.SpriteMaterial({ map: this.summitTexture, sizeAttenuation: true }),
        )
        sprite.center.set(0.5, 0.02)
        const s = pinH * 0.85
        sprite.scale.set(s * SUMMIT_ASPECT, s, 1)
        sprite.position.set(sc[0], this.elevToY(this.summit.elev), sc[1])
        // Not in pinSprites: the benchmark is terrain furniture, not clickable
        this.overlayGroup.add(sprite)
      }
    }

    for (const ov of this.lastOverlays) {
      if (!ov.visible) continue

      if (ov.kind === 'track') {
        for (const seg of ov.segments) {
          for (const run of projectTrackSegment(hf, seg, maxSeg)) {
            if (run.length < 2) continue
            const flat: number[] = []
            for (const [x, z] of run) {
              flat.push(x, this.elevToY(hf.heightAt(x, z)) + lift, z)
            }
            const geom = new LineGeometry()
            geom.setPositions(flat)
            const mat = new LineMaterial({
              color: new THREE.Color(ov.color).getHex(),
              linewidth: 3.5,
              // Pull line fragments toward the camera in depth so the small
              // lift never z-fights the terrain
              polygonOffset: true,
              polygonOffsetFactor: -2,
              polygonOffsetUnits: -4,
            })
            mat.resolution.set(this.canvas.clientWidth, this.canvas.clientHeight)
            this.lineMaterials.push(mat)
            const line = new Line2(geom, mat)
            line.computeLineDistances()
            this.overlayGroup.add(line)
          }
        }
      } else {
        if (ov.lon == null || ov.lat == null) continue
        const sc = hf.sceneFromLonLat(ov.lon, ov.lat)
        if (!sc) continue
        const [x, z] = sc

        let tex: THREE.Texture
        if (ov.kind === 'photo') {
          let cached = this.pinTextures.get(ov.id)
          if (!cached) {
            cached = makePhotoPinTexture(ov.dataUrl, () => undefined)
            this.pinTextures.set(ov.id, cached)
          }
          tex = cached
        } else if (ov.color) {
          let cached = this.pinTextures.get(ov.id)
          if (!cached) {
            cached = makeNotePinTexture(ov.color)
            this.pinTextures.set(ov.id, cached)
          }
          tex = cached
        } else {
          tex = this.notePinTexture
        }

        const sprite = new THREE.Sprite(
          new THREE.SpriteMaterial({ map: tex, sizeAttenuation: true }),
        )
        sprite.center.set(0.5, 0.02)
        const base = pinH * (ov.scale ?? 1)
        const s = ov.id === this.lastSelected ? base * 1.25 : base
        sprite.scale.set(s * PIN_ASPECT, s, 1)
        sprite.position.set(x, this.elevToY(hf.heightAt(x, z)), z)
        sprite.userData.overlayId = ov.id
        this.pinSprites.push(sprite)
        this.overlayGroup.add(sprite)
      }
    }
  }

  // ---- picking ----------------------------------------------------------

  // ---- compass ----------------------------------------------------------

  /**
   * Animate the camera azimuth back to north-up, keeping distance and tilt.
   * Scene z is south, so spherical theta 0 means the camera sits south of
   * the target looking north.
   */
  faceNorth(): void {
    this.camAnim = null
    const offset = this.camera.position.clone().sub(this.controls.target)
    const sph = new THREE.Spherical().setFromVector3(offset)
    if (Math.abs(sph.theta) < 0.002) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      sph.theta = 0
      this.camera.position
        .copy(this.controls.target)
        .add(new THREE.Vector3().setFromSpherical(sph))
      this.controls.update()
      return
    }
    this.northAnim = {
      fromTheta: sph.theta,
      radius: sph.radius,
      phi: sph.phi,
      start: performance.now(),
      dur: 700,
    }
  }

  private onPointerDown = (e: PointerEvent): void => {
    this.northAnim = null
    if (e.button === 0) {
      this.pointerDown = { x: e.clientX, y: e.clientY, button: e.button }
    }
  }

  private onPointerUp = (e: PointerEvent): void => {
    const down = this.pointerDown
    this.pointerDown = null
    if (!down || e.button !== 0) return
    if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6) return
    if (!this.hfInternal) return

    const rect = this.canvas.getBoundingClientRect()
    const ndc = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    )
    this.raycaster.setFromCamera(ndc, this.camera)

    const pinHits = this.raycaster.intersectObjects(this.pinSprites, false)
    if (pinHits.length > 0) {
      this.events.onSelectOverlay(pinHits[0].object.userData.overlayId as string)
      return
    }

    const hit = this.hfInternal.raycast(
      this.raycaster.ray,
      this.exag,
      this.hfInternal.meta.min_elev,
    )
    if (hit) {
      const [lon, lat] = this.hfInternal.lonLatFromScene(hit.x, hit.z)
      this.events.onPickTerrain(lon, lat, this.hfInternal.heightAt(hit.x, hit.z))
    } else {
      this.events.onSelectOverlay(null)
    }
  }

  // ---- loop / sizing ----------------------------------------------------

  private tick = (): void => {
    if (this.camAnim) {
      const { fromPos, toPos, start, dur } = this.camAnim
      const t = Math.min((performance.now() - start) / dur, 1)
      const ease = 1 - Math.pow(1 - t, 3)
      this.camera.position.lerpVectors(fromPos, toPos, ease)
      if (t >= 1) this.camAnim = null
    }
    if (this.northAnim) {
      const { fromTheta, radius, phi, start, dur } = this.northAnim
      const t = Math.min((performance.now() - start) / dur, 1)
      const ease = 1 - Math.pow(1 - t, 3)
      const sph = new THREE.Spherical(radius, phi, fromTheta * (1 - ease))
      this.camera.position
        .copy(this.controls.target)
        .add(new THREE.Vector3().setFromSpherical(sph))
      if (t >= 1) this.northAnim = null
    }
    this.controls.update()

    const roseDeg = THREE.MathUtils.radToDeg(this.controls.getAzimuthalAngle())
    if (Math.abs(roseDeg - this.lastRoseDeg) > 0.2) {
      this.lastRoseDeg = roseDeg
      this.events.onHeadingChange(roseDeg)
    }

    this.renderer.render(this.scene, this.camera)
  }

  private resize(): void {
    const parent = this.canvas.parentElement
    if (!parent) return
    const w = parent.clientWidth
    const h = parent.clientHeight
    if (w === 0 || h === 0) return
    this.renderer.setSize(w, h, false)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
    for (const m of this.lineMaterials) m.resolution.set(w, h)
  }

  dispose(): void {
    this.renderer.setAnimationLoop(null)
    this.resizeObserver.disconnect()
    this.canvas.removeEventListener('pointerdown', this.onPointerDown)
    this.canvas.removeEventListener('pointerup', this.onPointerUp)
    this.clearOverlayGroup()
    for (const [, tex] of this.pinTextures) tex.dispose()
    this.pinTextures.clear()
    this.notePinTexture.dispose()
    this.summitTexture?.dispose()
    this.terrain?.geometry.dispose()
    this.material.map?.dispose()
    this.material.dispose()
    this.controls.dispose()
    this.renderer.dispose()
  }
}
