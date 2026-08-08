import * as THREE from 'three'
import { MapControls } from 'three/addons/controls/MapControls.js'
import { Line2 } from 'three/addons/lines/Line2.js'
import { LineGeometry } from 'three/addons/lines/LineGeometry.js'
import { LineMaterial } from 'three/addons/lines/LineMaterial.js'
import { decodeFloat32Tiff, type DecodedRaster } from './direct/tiff'
import { demUrl, textureUrl, type Bbox } from './direct/usgs'
import {
  buildHillshadeTexture,
  buildTerrainGeometry,
  Heightfield,
  projectTrackSegment,
} from './geo'
import type { LightingJob, LightingResult } from './lighting-worker'
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

export interface ViewerOptions {
  /**
   * Factory for the terrain lighting bake worker. Injected rather than
   * constructed in here so that this module's graph stays worker-free: the
   * standalone export is a single-chunk IIFE bundle, and a
   * `new Worker( new URL( ... ) )` anywhere in it makes the build emit a
   * second file that a file:// export has no way to load. Omit it and the
   * bakes fall back to the synchronous geo.ts hillshade.
   */
  lightingWorker?: () => Worker
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

// ---- zoom detail + relief shading constants ----------------------------

// Fetch a sharper sub-area export once the ground the camera is looking at
// is closer than this. Judged by the look-at point's distance, not the
// frame's ground footprint - an oblique mountain view sweeps kilometres of
// background that the patch was never meant to cover, and a footprint test
// would keep the feature from ever engaging.
const DETAIL_MAX_SPAN_M = 3000
// Never fetch below this ground span: 2048 px over 600 m is ~0.3 m/px,
// already past what NAIP resolves.
const DETAIL_MIN_SPAN_M = 600
// Only hits this close to the look-at point size the patch; farther ones
// are background and keep the base texture.
const DETAIL_NEAR_M = 1500
// Patch never wider than this: past it a 2048 px export stops clearly
// out-resolving a 4096 base, and the sharpness gate would veto anyway.
const DETAIL_PATCH_CAP_M = 2500
const DETAIL_SIZE = 2048
// Patch DEM export sizes for the detail hillshade bake, chosen per patch:
// the smallest power of two putting at least 3x the base grid's samples
// across the window, so the rebaked shading clearly out-resolves the base
// bake instead of resampling it. Capped at 1024 (~2.4 m/px over the 2.5 km
// patch cap) because each doubling quadruples the worker's horizon-march
// cost for frequencies the shadow's soft penumbra blurs away anyway.
const DETAIL_DEM_MIN = 256
const DETAIL_DEM_MAX = 1024
// Idle time before the camera counts as at rest
const DETAIL_REST_MS = 500

// Where the view is sampled to find the on-screen ground extent. Center
// first - a center miss means mostly sky, and a patch would be guesswork.
const DETAIL_NDC: readonly (readonly [number, number])[] = [
  [0, 0],
  [-0.85, 0],
  [0.85, 0],
  [0, -0.85],
  [0, 0.85],
  [-0.85, -0.85],
  [0.85, -0.85],
  [-0.85, 0.85],
  [0.85, 0.85],
]

// Stands in for the contour interval while contours are off: the shader
// divides by it unconditionally, and a 0 there would be a NaN waiting for
// the next frame that turns them on.
const CONTOUR_FALLBACK_M = 50

// Replaces three's map_fragment chunk. Everything sits inside USE_MAP, so
// the untextured 'shaded' layer compiles to the stock shader and renders
// exactly as before. The detail patch blends over the base drape inside its
// UV window with a smoothstep edge; the hillshade and the sky-view ambient
// occlusion then multiply both, and the slope tint and contour ink go on
// last so map furniture sits over the shading rather than under it. When a
// patch hillshade is live it replaces the base hillshade inside the same
// window rather than multiplying over it - both bakes shadow the same sun,
// so stacking them would darken every shadowed texel twice. Texture
// samples stay in dynamically-uniform control flow so the implicit mipmap
// derivatives remain defined, and each strength uniform stays 0 until its
// bake exists so no branch ever samples three's black fallback texture.
const DRAPE_MAP_FRAGMENT = /* glsl */ `
#ifdef USE_MAP
  vec4 sampledDiffuseColor = texture2D( map, vMapUv );
  if ( uDetailFade > 0.0 ) {
    vec2 dUv = ( vMapUv - uDetailWindow.xy ) / uDetailWindow.zw;
    vec2 edge = smoothstep( vec2( 0.0 ), vec2( 0.06 ), dUv )
      * smoothstep( vec2( 0.0 ), vec2( 0.06 ), vec2( 1.0 ) - dUv );
    vec3 detail = texture2D( uDetailMap, clamp( dUv, 0.0, 1.0 ) ).rgb;
    sampledDiffuseColor.rgb = mix( sampledDiffuseColor.rgb, detail, edge.x * edge.y * uDetailFade );
  }
  if ( uRelief > 0.0 ) {
    float shade = texture2D( uHillshadeMap, vMapUv ).r;
    if ( uDetailShadeOn > 0.0 ) {
      vec2 sUv = ( vMapUv - uDetailWindow.xy ) / uDetailWindow.zw;
      vec2 sEdge = smoothstep( vec2( 0.0 ), vec2( 0.06 ), sUv )
        * smoothstep( vec2( 0.0 ), vec2( 0.06 ), vec2( 1.0 ) - sUv );
      float fine = texture2D( uDetailShadeMap, clamp( sUv, 0.0, 1.0 ) ).r;
      shade = mix( shade, fine, sEdge.x * sEdge.y * uDetailShadeOn );
    }
    sampledDiffuseColor.rgb *= mix( 1.0, shade, uRelief );
  }
  if ( uAo > 0.0 ) {
    // The exponent widens the sky-view factor's narrow range - open terrain
    // sits close to 1.0 and would otherwise barely read as shaded at all
    float ao = pow( texture2D( uAoMap, vMapUv ).r, 1.5 );
    sampledDiffuseColor.rgb *= mix( 1.0, ao, uAo );
  }
  if ( uSlope > 0.0 ) {
    // Steepness of the real ground, not of the model: a vertical stretch
    // multiplies the surface gradient by uDrapeExag, so dividing the normal's
    // up component back out is what keeps 38 degrees meaning 38 degrees.
    // vDrapeNormal rather than three's vNormal because vNormal is view space
    // and would swing the whole ramp around as the camera orbits.
    float ny = max( normalize( vDrapeNormal ).y, 0.0 );
    float slopeDeg = degrees( atan( sqrt( max( 1.0 - ny * ny, 0.0 ) ), ny * uDrapeExag ) );
    // CalTopo's break points. The two-degree feathers are there so a band
    // edge crawling across a face does not crawl as a hard jagged line.
    // Ramped in sRGB and converted once: these are picked as swatches, and
    // crossfading them in linear light muddies the edges into brown.
    vec3 ramp = vec3( 1.0, 0.85, 0.2 );
    ramp = mix( ramp, vec3( 0.95, 0.55, 0.15 ), smoothstep( 31.0, 33.0, slopeDeg ) );
    ramp = mix( ramp, vec3( 0.85, 0.2, 0.15 ), smoothstep( 37.0, 39.0, slopeDeg ) );
    ramp = mix( ramp, vec3( 0.55, 0.2, 0.55 ), smoothstep( 44.0, 46.0, slopeDeg ) );
    ramp = mix( ramp, vec3( 0.35, 0.35, 0.55 ), smoothstep( 54.0, 56.0, slopeDeg ) );
    float band = smoothstep( 26.0, 28.0, slopeDeg );
    sampledDiffuseColor.rgb = mix( sampledDiffuseColor.rgb, drapeSrgb( ramp ), band * uSlope );
  }
  if ( uContours > 0.0 ) {
    // vDrapePos is object space, which is scene space for this mesh, so
    // undoing the vertical stretch recovers metres above sea level
    float t = ( vDrapePos.y / uDrapeExag + uMinElev ) / uContourInterval;
    // The index contour rides its own fifth-scale coordinate: five intervals
    // of real spacing, so it stays legible for five times the zoom-out the
    // intermediates survive, and it is wider and darker where both land
    float ink = max( 0.8 * drapeContour( t, 1.0 ), drapeContour( t * 0.2, 1.6 ) );
    // Warm dark brown - reads as ink on the topo's pale paper and still
    // separates from the satellite layer's greens and shadowed rock
    vec3 contourInk = drapeSrgb( vec3( 0.24, 0.18, 0.12 ) );
    sampledDiffuseColor.rgb = mix( sampledDiffuseColor.rgb, contourInk, ink * uContours );
  }
  diffuseColor *= sampledDiffuseColor;
#endif
`

// Prepended to the fragment shader. The two varyings carry what three does
// not hand the fragment shader in a usable frame: the pre-projection position
// (object space, so elevation survives) and the object-space normal (vNormal
// is view space).
const DRAPE_UNIFORM_DECLS = /* glsl */ `
uniform sampler2D uDetailMap;
uniform vec4 uDetailWindow;
uniform float uDetailFade;
uniform sampler2D uDetailShadeMap;
uniform float uDetailShadeOn;
uniform sampler2D uHillshadeMap;
uniform float uRelief;
uniform sampler2D uAoMap;
uniform float uAo;
uniform float uDrapeExag;
uniform float uMinElev;
uniform float uContourInterval;
uniform float uContours;
uniform float uSlope;
varying vec3 vDrapePos;
varying vec3 vDrapeNormal;

// The drape is sRGB-decoded by the sampler before any of this runs, so the
// map furniture below is written as sRGB swatches and converted here. Dropped
// in raw they would land as pale pastels, and the contour ink in particular
// would come out lighter than the satellite layer's forest - lines that flip
// from ink to highlight depending on what is underneath them. Every call site
// passes a constant, so this folds away at compile time.
vec3 drapeSrgb( vec3 c ) {
  return mix( c / 12.92, pow( ( c + 0.055 ) / 1.055, vec3( 2.4 ) ), step( 0.04045, c ) );
}

// One anti-aliased isoline field: t is elevation in interval units, so the
// integers are the lines and fwidth( t ) is how much of an interval one pixel
// covers. Everything is measured against that, which is what holds the lines
// at a fixed screen width from summit close-up to whole-range overview. Past
// ~4 px per interval no line can be drawn honestly, so it fades out - moire
// is worse than an absent contour.
float drapeContour( float t, float width ) {
  // Floored because smoothstep is undefined when its two edges meet, and a
  // dead-flat surface - a lake, a nodata fill - has a derivative of exactly 0
  float w = max( fwidth( t ), 1e-6 );
  float d = abs( t - round( t ) );
  float line = 1.0 - smoothstep( 0.75 * w * width, 1.5 * w * width, d );
  return line * ( 1.0 - smoothstep( 0.15, 0.28, w ) );
}
`

const DRAPE_VERTEX_DECLS = /* glsl */ `
varying vec3 vDrapePos;
varying vec3 vDrapeNormal;
`

/**
 * Wrap a worker bake as a texture, matching what the terrain UVs expect: one
 * byte per texel, rows already flipped by the bake so v = 1 is north.
 */
function singleChannelTexture(data: Uint8Array, w: number, h: number): THREE.DataTexture {
  const tex = new THREE.DataTexture(data, w, h, THREE.RedFormat, THREE.UnsignedByteType)
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.magFilter = THREE.LinearFilter
  tex.generateMipmaps = true
  // Single-byte rows are not 4-byte aligned at every width
  tex.unpackAlignment = 1
  tex.needsUpdate = true
  return tex
}

// Decoded patch DEM, cached while its patch is live so a sun move rebakes
// the shade without refetching. Offsets are ground metres from the base
// grid's northwest corner - the placement the worker's shadow march needs
// to keep walking once it leaves the patch.
interface DetailDem {
  data: Float32Array
  width: number
  height: number
  groundSize: number
  offE: number
  offS: number
}

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

  // Detail patch, relief shading, slope tint and contours. drapeUniforms is
  // shared with every compiled variant of the terrain shader by reference, so
  // writing .value here reaches the GPU without touching the material.
  private drapeUniforms = {
    uDetailMap: { value: null as THREE.Texture | null },
    uDetailWindow: { value: new THREE.Vector4(0, 0, 1, 1) },
    uDetailFade: { value: 0 },
    uDetailShadeMap: { value: null as THREE.Texture | null },
    uDetailShadeOn: { value: 0 },
    uHillshadeMap: { value: null as THREE.Texture | null },
    uRelief: { value: 0 },
    uAoMap: { value: null as THREE.Texture | null },
    uAo: { value: 0 },
    uDrapeExag: { value: 1 },
    uMinElev: { value: 0 },
    // Never 0 even while the lines are off - it is a divisor
    uContourInterval: { value: CONTOUR_FALLBACK_M },
    uContours: { value: 0 },
    uSlope: { value: 0 },
  }
  private drapeKind: 'topo' | 'imagery' | null = null
  // True while the bound map is not yet the current kind's base drape (layer
  // or area just changed) - a detail patch fetched then would blend the new
  // layer's pixels over the old layer's texture
  private basePending = false
  private reliefStrength = 0
  private aoStrength = 0
  private contourInterval = 0
  private slopeStrength = 0
  private sun: THREE.DirectionalLight
  private sunAz = 135
  private sunAlt = 45
  private sunTimer: ReturnType<typeof setTimeout> | null = null
  private hillshadeTexture: THREE.DataTexture | null = null
  private hillshadeTimer: ReturnType<typeof setTimeout> | null = null
  private aoTexture: THREE.DataTexture | null = null
  // Lazily spawned, and never respawned once it has failed: a webview that
  // refuses module workers refuses them every time
  private lighting: Worker | null = null
  private lightingBroken = false
  private lightingJob = 0
  // The one bake of each kind still in flight, with the state it was baked
  // for - a reply whose id no longer matches, or whose terrain or sun has
  // moved on, describes something that is no longer on screen
  private hillshadeReq: { id: number; hf: Heightfield; az: number; alt: number } | null = null
  private aoReq: { id: number; hf: Heightfield } | null = null
  private detailToken = 0
  private detailAbort: AbortController | null = null
  private detailTexture: THREE.Texture | null = null
  private detailBbox: Bbox | null = null
  private detailFade: { start: number } | null = null
  // Patch hillshade for the live detail window. The shade record carries the
  // sun angles it was baked for, so staleness is a comparison rather than a
  // flag someone has to remember to set.
  private detailDemAbort: AbortController | null = null
  private detailDem: DetailDem | null = null
  private detailShade: { texture: THREE.DataTexture; az: number; alt: number } | null = null
  private detailShadeReq: { id: number; token: number; az: number; alt: number } | null = null
  // Camera-rest tracking for the detail fetch
  private lastCamPos = new THREE.Vector3()
  private lastCamTarget = new THREE.Vector3()
  private lastMoveAt = 0
  private restHandled = true
  private ndcTmp = new THREE.Vector2()

  private hfInternal: Heightfield | null = null
  private exag = 1
  private lastOverlays: Overlay[] = []
  private lastSelected: string | null = null
  // Draped track polylines for screen-space picking (scene coordinates,
  // the same subdivided runs the Line2 geometries were built from)
  private trackRuns: { id: string; flat: number[] }[] = []
  // Off while a placement mode owns clicks - a route sweeps the whole
  // terrain, and dropping a note onto the track is a normal thing to do
  private trackPicking = true

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
    private opts: ViewerOptions = {},
  ) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.05

    this.camera = new THREE.PerspectiveCamera(55, 1, 1, 1e7)
    this.camera.position.set(2000, 2000, 3000)

    const hemi = new THREE.HemisphereLight(0xe8f0f7, 0x8a7f6a, 0.85)
    this.scene.add(hemi)
    this.sun = new THREE.DirectionalLight(0xfff2de, 2.0)
    // Morning sun in the southeast until told otherwise
    this.placeSun()
    this.scene.add(this.sun)
    this.scene.add(this.overlayGroup)

    this.material = new THREE.MeshStandardMaterial({
      color: SHADED_COLOR,
      roughness: 1,
      metalness: 0,
    })
    // Same material for every layer; the injected chunk only runs when a
    // map is bound. three keys its program cache on this function's source
    // plus USE_MAP, so the shaded and draped variants coexist.
    this.material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.drapeUniforms)
      // Both varyings are written unconditionally, on the shaded layer too:
      // the vertex shader has no USE_MAP branch to hang them off, and an
      // unread varying costs one interpolator the terrain has to spare.
      shader.vertexShader =
        DRAPE_VERTEX_DECLS +
        shader.vertexShader
          .replace(
            '#include <beginnormal_vertex>',
            '#include <beginnormal_vertex>\n  vDrapeNormal = objectNormal;',
          )
          .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vDrapePos = transformed;')
      shader.fragmentShader =
        DRAPE_UNIFORM_DECLS +
        shader.fragmentShader.replace('#include <map_fragment>', DRAPE_MAP_FRAGMENT)
    }

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

    // The old hillshade, ambient occlusion and detail patch describe the old
    // terrain, the bound base texture is stale until the layer effect
    // reloads it, and any in-flight base load still belongs to the old area
    this.clearDetail()
    this.basePending = true
    this.textureToken++
    this.hillshadeTexture?.dispose()
    this.hillshadeTexture = null
    this.aoTexture?.dispose()
    this.aoTexture = null
    this.hillshadeReq = null
    this.aoReq = null
    this.drapeUniforms.uHillshadeMap.value = null
    this.drapeUniforms.uAoMap.value = null
    // The datum the shader reads elevation back out against - vertex y is
    // metres above this area's floor, not above sea level
    this.drapeUniforms.uMinElev.value = meta.min_elev
    this.drapeUniforms.uDrapeExag.value = Math.max(this.exag, 1e-3)
    this.applyRelief()

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
    // Contours and the slope ramp both read metres back out of the stretched
    // vertex y, so this has to move with the geometry. Floored because the
    // shader divides by it - a flattened terrain is better than a NaN drape.
    this.drapeUniforms.uDrapeExag.value = Math.max(exag, 1e-3)
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
    // The reshaped terrain changes what the camera sees - re-evaluate the
    // detail patch without waiting for a camera nudge
    this.restHandled = false
    this.lastMoveAt = performance.now()
    this.renderOverlays()
  }

  // ---- draped layers ----------------------------------------------------

  setShaded(): void {
    this.textureToken++
    this.clearDetail()
    if (this.material.map) {
      this.material.map.dispose()
      this.material.map = null
    }
    this.material.color.set(SHADED_COLOR)
    this.material.needsUpdate = true
  }

  async setTextureUrl(url: string): Promise<void> {
    const token = ++this.textureToken
    let tex: THREE.Texture
    try {
      tex = await new THREE.TextureLoader().loadAsync(url)
    } catch (err) {
      // Only the current load's failure may reach the caller - a superseded
      // load rejecting late would fire the caller's fallback with a stale
      // closure over the wrong area or layer
      if (token !== this.textureToken) return
      throw err
    }
    if (token !== this.textureToken) {
      tex.dispose()
      return
    }
    // Decode now so the first render tick that samples the texture does not
    // pay a synchronous decode. Bounded: Chrome can leave decode() pending
    // indefinitely (observed on 4096px JPEGs), and an unresolved await here
    // would strand the drape unbound - the upload-time decode stall is the
    // lesser evil.
    try {
      const d = (tex.image as { decode?: () => Promise<void> }).decode?.()
      if (d) await Promise.race([d, new Promise((r) => setTimeout(r, 1500))])
    } catch {
      // Decode errors are fine - the GPU upload decodes it instead
    }
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
    // A fresh base drape unblocks detail fetching and restarts the idle
    // clock, so a camera already at rest still gets its patch evaluated
    this.basePending = false
    this.restHandled = false
    this.lastMoveAt = performance.now()
  }

  // ---- zoom detail + relief shading -------------------------------------

  /**
   * Which base drape is showing. Gates both the zoom-detail fetch and the
   * relief hillshade: the shaded layer and custom layers pass null and get
   * neither.
   */
  setDrapeKind(kind: 'topo' | 'imagery' | null): void {
    if (kind === this.drapeKind) return
    this.drapeKind = kind
    // A patch fetched for the old layer is the wrong content for the new
    // one, and the new base texture has not landed yet
    this.clearDetail()
    this.basePending = true
    this.applyRelief()
  }

  /** Relief hillshade strength over the drape, 0..1. */
  setReliefStrength(strength: number): void {
    this.reliefStrength = strength
    this.applyRelief()
  }

  /**
   * Ambient occlusion strength over the drape, 0..1. The sky-view bake it
   * samples does not depend on the sun, so moving the sun never rebakes it.
   */
  setAoStrength(strength: number): void {
    this.aoStrength = strength
    this.applyRelief()
  }

  /**
   * Elevation contour interval in metres over the drape; 0 turns them off.
   * Unlike relief and ambient occlusion these are computed per fragment from
   * the vertex height, so there is no bake to wait for and no texture
   * resolution to outrun - the lines stay sharp at any zoom.
   */
  setContourInterval(meters: number): void {
    this.contourInterval = meters > 0 ? meters : 0
    this.drapeUniforms.uContourInterval.value = this.contourInterval || CONTOUR_FALLBACK_M
    this.drapeUniforms.uContours.value = this.contourInterval > 0 ? 1 : 0
  }

  /**
   * Slope-angle tint strength over the drape, 0..1. Also bake-free: the angle
   * comes from the surface normal the mesh already carries.
   */
  setSlopeShading(strength: number): void {
    this.slopeStrength = THREE.MathUtils.clamp(strength, 0, 1)
    this.drapeUniforms.uSlope.value = this.slopeStrength
  }

  /**
   * Sun position: compass azimuth in degrees (0 = sun in the north) and
   * altitude above the horizon. The scene light moves immediately - live
   * feedback on every layer, including the untextured shaded one - while
   * the per-texel hillshade rebake is debounced behind the slider drag,
   * keeping the old bake on screen until the new one lands.
   */
  setSunPosition(azimuthDeg: number, altitudeDeg: number): void {
    if (azimuthDeg === this.sunAz && altitudeDeg === this.sunAlt) return
    this.sunAz = azimuthDeg
    this.sunAlt = altitudeDeg
    this.placeSun()
    if (this.sunTimer !== null) clearTimeout(this.sunTimer)
    this.sunTimer = setTimeout(() => {
      this.sunTimer = null
      // Only when a bake is already on screen; otherwise the lazy path in
      // applyRelief builds with the current angles when first needed
      if (this.hfInternal && this.hillshadeTexture) this.requestHillshade(this.hfInternal)
      // Same rule for the patch shade, same no-flicker behavior: the old
      // bake stays up until one for the new angles lands
      if (this.hfInternal && this.detailShade) this.requestDetailShade()
    }, 150)
  }

  /** Scene space is x = east, y = up, z = south. */
  private placeSun(): void {
    const az = THREE.MathUtils.degToRad(this.sunAz)
    const alt = THREE.MathUtils.degToRad(this.sunAlt)
    this.sun.position.set(
      Math.sin(az) * Math.cos(alt),
      Math.sin(alt),
      -Math.cos(az) * Math.cos(alt),
    )
  }

  private applyRelief(): void {
    const hf = this.hfInternal
    const draped = this.drapeKind !== null && hf !== null
    const relief = draped && this.reliefStrength > 0
    const ao = draped && this.aoStrength > 0
    // Live only once the texture exists - the shader would otherwise sample
    // three's black fallback and darken the whole drape
    this.drapeUniforms.uRelief.value = relief && this.hillshadeTexture ? this.reliefStrength : 0
    this.drapeUniforms.uAo.value = ao && this.aoTexture ? this.aoStrength : 0
    if (!hf || !draped) return
    // Baked lazily - a session that never shows relief never pays for either
    // pass - and one bake of each kind at a time
    if (relief && !this.hillshadeTexture && !this.hillshadeReq) this.requestHillshade(hf)
    if ((relief || ao) && !this.aoTexture && !this.aoReq) this.requestAo(hf)
    // The patch shade waits on relief too - its DEM fetch and bake are
    // wasted while nothing multiplies them in. This is also what catches a
    // patch that went live while relief was off; freshness checks inside.
    if (relief) this.requestDetailShade()
  }

  /**
   * The bake worker, spawned on first need. No factory, or a webview that
   * refuses module workers, gets the geo.ts hillshade instead: no cast
   * shadows and no ambient occlusion, but relief still works.
   */
  private lightingWorker(): Worker | null {
    if (this.lighting || this.lightingBroken) return this.lighting
    const make = this.opts.lightingWorker
    if (!make) {
      this.lightingBroken = true
      return null
    }
    try {
      const w = make()
      w.onmessage = this.onLightingResult
      // A worker that fails to load reports it here, not at construction
      w.onerror = () => {
        this.lightingBroken = true
        this.lighting?.terminate()
        this.lighting = null
        this.hillshadeReq = null
        this.aoReq = null
        this.detailShadeReq = null
        this.applyRelief()
      }
      this.lighting = w
    } catch {
      this.lightingBroken = true
      this.lighting = null
    }
    return this.lighting
  }

  // hf.data stays in use on the main thread for picking and draping, and the
  // patch DEM stays cached for sun rebakes, so every job carries copies -
  // transferred, not structured-cloned a second time
  private postLightingJob(job: LightingJob): void {
    const transfer: ArrayBuffer[] = [job.heights.buffer as ArrayBuffer]
    if (job.job === 'patchHillshade') transfer.push(job.baseHeights.buffer as ArrayBuffer)
    this.lighting?.postMessage(job, transfer)
  }

  private requestHillshade(hf: Heightfield): void {
    // One bake in flight at a time. The worker drains its queue in order, so
    // a second job posted mid-drag would only be reached once it was already
    // stale, and each job carries a copy of the whole DEM; the reply handler
    // re-fires instead when the sun has moved on.
    if (this.hillshadeReq) return
    if (!this.lightingWorker()) {
      // Off the current tick even synchronously: the full-grid pass would
      // otherwise hitch the slider frame that asked for it
      if (this.hillshadeTimer !== null) return
      this.hillshadeTimer = setTimeout(() => {
        this.hillshadeTimer = null
        if (this.hfInternal !== hf) return
        const tex = buildHillshadeTexture(hf, this.sunAz, this.sunAlt)
        this.hillshadeTexture?.dispose()
        this.hillshadeTexture = tex
        this.drapeUniforms.uHillshadeMap.value = tex
        this.applyRelief()
      }, 0)
      return
    }
    const id = ++this.lightingJob
    this.hillshadeReq = { id, hf, az: this.sunAz, alt: this.sunAlt }
    this.postLightingJob({
      job: 'hillshade',
      jobId: id,
      heights: hf.data.slice(),
      width: hf.meta.width,
      height: hf.meta.height,
      groundSize: hf.meta.ground_size_m,
      sunAz: this.sunAz,
      sunAlt: this.sunAlt,
    })
  }

  private requestAo(hf: Heightfield): void {
    if (!this.lightingWorker()) return
    const id = ++this.lightingJob
    this.aoReq = { id, hf }
    this.postLightingJob({
      job: 'ao',
      jobId: id,
      heights: hf.data.slice(),
      width: hf.meta.width,
      height: hf.meta.height,
      groundSize: hf.meta.ground_size_m,
    })
  }

  private onLightingResult = (e: MessageEvent<LightingResult>): void => {
    const msg = e.data
    if (msg.job === 'hillshade') {
      if (!this.hillshadeReq || this.hillshadeReq.id !== msg.jobId) return
      const req = this.hillshadeReq
      this.hillshadeReq = null
      // A bake for terrain that has since been replaced is dropped outright;
      // applyRelief starts the new terrain's. One for a sun that moved again
      // while it ran is dropped and re-fired - whatever is already on screen
      // stays until a bake for the current angles lands.
      if (req.hf === this.hfInternal) {
        if (req.az === this.sunAz && req.alt === this.sunAlt) {
          this.hillshadeTexture?.dispose()
          this.hillshadeTexture = singleChannelTexture(msg.data, msg.width, msg.height)
          this.drapeUniforms.uHillshadeMap.value = this.hillshadeTexture
        } else {
          this.requestHillshade(req.hf)
        }
      }
    } else if (msg.job === 'patchHillshade') {
      if (!this.detailShadeReq || this.detailShadeReq.id !== msg.jobId) return
      const req = this.detailShadeReq
      this.detailShadeReq = null
      // Same discipline as the base bake: a reply for a patch that is gone
      // (token moved on) is dropped outright - the next camera rest re-kicks
      // if the patch survives - and one for a sun that moved again is
      // dropped and re-fired from the cached DEM. Whatever shade is on
      // screen stays up until a bake for the current angles lands.
      if (req.token === this.detailToken && this.detailBbox) {
        if (req.az === this.sunAz && req.alt === this.sunAlt) {
          this.detailShade?.texture.dispose()
          this.detailShade = {
            texture: singleChannelTexture(msg.data, msg.width, msg.height),
            az: req.az,
            alt: req.alt,
          }
          this.drapeUniforms.uDetailShadeMap.value = this.detailShade.texture
          this.drapeUniforms.uDetailShadeOn.value = 1
        } else {
          this.requestDetailShade()
        }
      }
    } else {
      if (!this.aoReq || this.aoReq.id !== msg.jobId) return
      const req = this.aoReq
      this.aoReq = null
      if (req.hf === this.hfInternal) {
        this.aoTexture?.dispose()
        this.aoTexture = singleChannelTexture(msg.data, msg.width, msg.height)
        this.drapeUniforms.uAoMap.value = this.aoTexture
      }
    }
    this.applyRelief()
  }

  private clearDetail(): void {
    this.detailToken++
    this.detailAbort?.abort()
    this.detailAbort = null
    this.detailFade = null
    this.drapeUniforms.uDetailFade.value = 0
    this.drapeUniforms.uDetailMap.value = null
    this.detailTexture?.dispose()
    this.detailTexture = null
    this.detailBbox = null
    this.clearDetailShade()
  }

  // Also called alone when a new patch replaces an old one: the old shade
  // was baked for the old window and would land misplaced under the new one
  private clearDetailShade(): void {
    this.detailDemAbort?.abort()
    this.detailDemAbort = null
    this.detailDem = null
    // In-flight bake replies check this by id, so nulling it is the drop
    this.detailShadeReq = null
    this.drapeUniforms.uDetailShadeOn.value = 0
    this.drapeUniforms.uDetailShadeMap.value = null
    this.detailShade?.texture.dispose()
    this.detailShade = null
  }

  /**
   * Higher-frequency hillshade for the live detail window, baked from a
   * finer DEM over the exact bbox the color patch fetched so the two share
   * one UV window texel-for-texel. Skipped without the bake worker: the
   * synchronous fallback has no cast shadows, and a sharper Lambert-only
   * patch inside a shadowed base would contradict it along the window edge.
   * Safe to call speculatively - every gate and freshness check lives here.
   */
  private requestDetailShade(): void {
    const hf = this.hfInternal
    const bbox = this.detailBbox
    if (!hf || !bbox || this.drapeKind === null || this.reliefStrength <= 0) return
    // One bake in flight at a time, like the base hillshade - the reply
    // handler re-fires when the sun has moved on
    if (this.detailShadeReq) return
    if (
      this.detailShade &&
      this.detailShade.az === this.sunAz &&
      this.detailShade.alt === this.sunAlt
    ) {
      return
    }
    if (!this.lightingWorker()) return
    if (this.detailDem) {
      this.postDetailShade(hf, this.detailDem)
    } else if (!this.detailDemAbort) {
      // No await here and the controller is set synchronously inside, so a
      // second call cannot start a duplicate fetch
      void this.fetchDetailDem(hf, bbox)
    }
  }

  /**
   * Fetch and decode the patch DEM, cache it, and kick the bake. Failures
   * are silent like the image patch - the base hillshade is always there.
   */
  private async fetchDetailDem(hf: Heightfield, bbox: Bbox): Promise<void> {
    // Smallest power of two with at least 3x the base grid's samples across
    // the window (see DETAIL_DEM_MIN/MAX for the bounds rationale)
    const groundSide = (bbox[2] - bbox[0]) * hf.meta.cos_lat
    const wanted = (3 * groundSide) / hf.meta.resolution_m
    let size = DETAIL_DEM_MIN
    while (size < wanted && size < DETAIL_DEM_MAX) size *= 2

    const abort = new AbortController()
    this.detailDemAbort = abort
    let raster: DecodedRaster
    try {
      const res = await fetch(demUrl(bbox, size), { signal: abort.signal })
      if (!res.ok) return
      // ArcGIS reports errors as JSON with HTTP 200
      if (!(res.headers.get('content-type') ?? '').includes('tiff')) return
      raster = decodeFloat32Tiff(await res.arrayBuffer())
    } catch {
      // Abort, network and malformed-TIFF failures are equally silent
      return
    } finally {
      if (this.detailDemAbort === abort) this.detailDemAbort = null
    }
    // The patch this DEM was fetched for must still be the live one - bbox
    // identity, not value equality, because refreshDetail commits a fresh
    // array per patch and clearDetail nulls it
    if (this.detailBbox !== bbox || this.hfInternal !== hf) return
    // The area's own decode cleaned nodata down to the grid minimum; a
    // patch can still catch a void (waterbodies often are in 3DEP), and a
    // single 3.4e38 sample would blow the bake's headroom cutoff wide open
    const d = raster.data
    for (let i = 0; i < d.length; i++) {
      const v = d[i]
      if (!(Number.isFinite(v) && v > -12000 && v < 12000)) d[i] = hf.meta.min_elev
    }
    const [axmin, , , aymax] = hf.meta.bbox3857
    this.detailDem = {
      data: d,
      width: raster.width,
      height: raster.height,
      // Ground metres, the worker grids' unit: mercator lengths over-count
      // ground by 1/cos(lat), the same correction the base metadata carries
      groundSize: groundSide,
      offE: (bbox[0] - axmin) * hf.meta.cos_lat,
      offS: (aymax - bbox[3]) * hf.meta.cos_lat,
    }
    // Back through the gates rather than straight to the bake: relief may
    // have turned off or the sun debounce may still be running
    this.requestDetailShade()
  }

  private postDetailShade(hf: Heightfield, dem: DetailDem): void {
    const id = ++this.lightingJob
    this.detailShadeReq = { id, token: this.detailToken, az: this.sunAz, alt: this.sunAlt }
    this.postLightingJob({
      job: 'patchHillshade',
      jobId: id,
      // Sliced because the cache keeps the original for the next sun move
      // while the post transfers this buffer away
      heights: dem.data.slice(),
      width: dem.width,
      height: dem.height,
      groundSize: dem.groundSize,
      sunAz: this.sunAz,
      sunAlt: this.sunAlt,
      baseHeights: hf.data.slice(),
      baseWidth: hf.meta.width,
      baseHeight: hf.meta.height,
      baseGroundSize: hf.meta.ground_size_m,
      baseOffsetEast: dem.offE,
      baseOffsetSouth: dem.offS,
    })
  }

  /**
   * Rest detection for the detail fetch. MapControls' 'end' event fires on
   * pointer release, before the damped glide settles, so rest has to mean
   * frame-to-frame stillness of both camera and target. Any motion cancels
   * an in-flight fetch; sustained stillness triggers one evaluation.
   */
  private trackCameraRest(now: number): void {
    const eps = (this.hfInternal?.meta.ground_size_m ?? 1000) * 1e-5
    const moving =
      this.camAnim !== null ||
      this.northAnim !== null ||
      this.camera.position.distanceToSquared(this.lastCamPos) > eps * eps ||
      this.controls.target.distanceToSquared(this.lastCamTarget) > eps * eps
    this.lastCamPos.copy(this.camera.position)
    this.lastCamTarget.copy(this.controls.target)
    if (moving) {
      this.detailToken++
      this.detailAbort?.abort()
      this.detailAbort = null
      this.lastMoveAt = now
      this.restHandled = false
    } else if (!this.restHandled && now - this.lastMoveAt >= DETAIL_REST_MS) {
      this.restHandled = true
      void this.refreshDetail()
    }
  }

  /**
   * Fetch a sharper export for just the viewed sub-area and blend it over
   * the base drape. Failures are deliberately silent - the base texture is
   * always there, and the service worker replays past fetches offline.
   */
  private async refreshDetail(): Promise<void> {
    const hf = this.hfInternal
    const kind = this.drapeKind
    if (!hf || !kind || this.basePending || !this.material.map) return
    const [bxmin, bymin, bxmax, bymax] = hf.meta.bbox3857
    const mercW = bxmax - bxmin
    const mercH = bymax - bymin
    // Mercator meters over-count ground meters by 1/cos(lat)
    const mercPerGround = mercW / hf.meta.ground_size_m
    const half = hf.half

    const pts: [number, number][] = []
    let cmx = 0
    let cmy = 0
    let centerDist = Infinity
    for (const [nx, ny] of DETAIL_NDC) {
      this.raycaster.setFromCamera(this.ndcTmp.set(nx, ny), this.camera)
      const hit = hf.raycast(this.raycaster.ray, this.exag, hf.meta.min_elev)
      if (!hit) {
        if (nx === 0 && ny === 0) return
        continue
      }
      const mx = bxmin + ((hit.x + half) / (2 * half)) * mercW
      const my = bymax - ((hit.z + half) / (2 * half)) * mercH
      if (nx === 0 && ny === 0) {
        cmx = mx
        cmy = my
        // Scene units are ground meters, so this is the ground distance to
        // whatever the camera is pointed at
        centerDist = this.camera.position.distanceTo(hit)
      }
      pts.push([mx, my])
    }
    if (pts.length < 3) return
    if (centerDist > DETAIL_MAX_SPAN_M) {
      // Looking at distant ground: a lingering patch would show its
      // scale-dependent styling as a mismatched rectangle in the overview
      if (this.detailTexture) this.clearDetail()
      return
    }
    // Size the patch from the hits near the look-at point only - top-edge
    // rays in an up-slope composition land kilometres away, and the patch
    // serves the ground the eye is on, not the whole frame.
    const nearMerc = DETAIL_NEAR_M * mercPerGround
    let minX = Infinity
    let maxX = -Infinity
    let minY = Infinity
    let maxY = -Infinity
    for (const [mx, my] of pts) {
      if (Math.abs(mx - cmx) > nearMerc || Math.abs(my - cmy) > nearMerc) continue
      if (mx < minX) minX = mx
      if (mx > maxX) maxX = mx
      if (my < minY) minY = my
      if (my > maxY) maxY = my
    }
    const spanMerc = Math.max(maxX - minX, maxY - minY)

    // Square sub-bbox around the visible extent, clamped inside the area.
    // Edges snapped to a 50 m grid so near-identical views produce the same
    // URL and revisits collide with the service worker's cached entries.
    let side = THREE.MathUtils.clamp(
      spanMerc * 1.15,
      DETAIL_MIN_SPAN_M * mercPerGround,
      DETAIL_PATCH_CAP_M * mercPerGround,
    )
    // Not worth a fetch unless the patch clearly out-resolves the bound
    // base texture, whatever size that was exported at
    const basePx = (this.material.map.image as { width?: number } | null)?.width ?? 2048
    if (side * basePx * 1.5 > mercW * DETAIL_SIZE) {
      // A bound patch from a closer zoom no longer out-resolves the base at
      // this distance either - drop it (the sw cache makes refetch free)
      if (this.detailTexture) this.clearDetail()
      return
    }
    side = Math.ceil(side / 50) * 50
    const sxmin =
      Math.round(THREE.MathUtils.clamp((minX + maxX - side) / 2, bxmin, bxmax - side) / 50) * 50
    const symin =
      Math.round(THREE.MathUtils.clamp((minY + maxY - side) / 2, bymin, bymax - side) / 50) * 50
    const bbox: Bbox = [sxmin, symin, sxmin + side, symin + side]

    // Close enough to the patch already showing - nothing to refetch
    const prev = this.detailBbox
    if (
      prev &&
      Math.abs(prev[2] - prev[0] - side) < side * 0.2 &&
      Math.abs((prev[0] + prev[2]) / 2 - (sxmin + side / 2)) < side * 0.15 &&
      Math.abs((prev[1] + prev[3]) / 2 - (symin + side / 2)) < side * 0.15
    ) {
      // The patch stands, but its shade may not: a camera nudge mid-bake
      // token-drops the reply, so every rest on the same patch is the
      // retry. No-ops when a current shade or an in-flight bake exists.
      this.requestDetailShade()
      return
    }

    const token = ++this.detailToken
    this.detailAbort?.abort()
    const abort = new AbortController()
    this.detailAbort = abort
    let bitmap: ImageBitmap
    try {
      const res = await fetch(textureUrl(bbox, kind, DETAIL_SIZE), { signal: abort.signal })
      if (!res.ok) return
      // createImageBitmap decodes the 2048px image off the main thread.
      // ImageBitmap uploads ignore UNPACK_FLIP_Y_WEBGL, so the flip that
      // TextureLoader would apply at upload (terrain UVs put v = 1 at
      // north, the image's top row) is baked in at decode instead;
      // premultiply is off to match the loader path's upload
      bitmap = await createImageBitmap(await res.blob(), {
        imageOrientation: 'flipY',
        premultiplyAlpha: 'none',
      })
    } catch {
      // Abort and network failures are equally silent
      return
    }
    if (token !== this.detailToken || kind !== this.drapeKind || !this.material.map) {
      bitmap.close()
      return
    }
    const tex = new THREE.Texture(bitmap)
    tex.flipY = false
    tex.needsUpdate = true
    tex.colorSpace = THREE.SRGBColorSpace
    tex.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy())
    this.detailTexture?.dispose()
    this.detailTexture = tex
    this.detailBbox = bbox
    this.drapeUniforms.uDetailMap.value = tex
    this.drapeUniforms.uDetailWindow.value.set(
      (sxmin - bxmin) / mercW,
      (symin - bymin) / mercH,
      side / mercW,
      side / mercH,
    )
    // uDetailWindow just moved, and the old shade was baked for where it
    // used to be - drop it now rather than blend misplaced shadows, and let
    // the base hillshade cover the window until the new bake lands
    this.clearDetailShade()
    this.requestDetailShade()
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      this.drapeUniforms.uDetailFade.value = 1
      this.detailFade = null
    } else {
      this.drapeUniforms.uDetailFade.value = 0
      this.detailFade = { start: performance.now() }
    }
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
    this.trackRuns = []
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
            this.trackRuns.push({ id: ov.id, flat })
            const geom = new LineGeometry()
            geom.setPositions(flat)
            const mat = new LineMaterial({
              color: new THREE.Color(ov.color).getHex(),
              linewidth: ov.id === this.lastSelected ? 5.5 : 3.5,
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

  /** Gate for track picking; off while a placement mode owns clicks. */
  setTrackPicking(enabled: boolean): void {
    this.trackPicking = enabled
  }

  /**
   * Screen-space pick against the draped track polylines: distance from the
   * click to each projected segment, nearest within 12 px wins. Line2's own
   * raycast needs world-unit thresholds that never feel right across zoom
   * levels; pixels are what the finger aims by. The winner is then checked
   * against the heightfield so a track behind a ridge is not clickable
   * through the mountain.
   */
  private pickTrack(px: number, py: number, rect: DOMRect): string | null {
    const hf = this.hfInternal
    if (!hf || this.trackRuns.length === 0) return null
    const THRESH = 12
    const viewProj = new THREE.Matrix4().multiplyMatrices(
      this.camera.projectionMatrix,
      this.camera.matrixWorldInverse,
    )
    const b = new THREE.Vector4()
    let bestD2 = THRESH * THRESH
    let bestId: string | null = null
    const bestPoint = new THREE.Vector3()
    for (const run of this.trackRuns) {
      const f = run.flat
      let ax = 0
      let ay = 0
      let aOk = false
      for (let i = 0; i + 2 < f.length; i += 3) {
        b.set(f[i], f[i + 1], f[i + 2], 1).applyMatrix4(viewProj)
        const bOk = b.w > 0
        const bx = ((b.x / b.w) * 0.5 + 0.5) * rect.width
        const by = ((-b.y / b.w) * 0.5 + 0.5) * rect.height
        if (aOk && bOk && i > 0) {
          const dx = bx - ax
          const dy = by - ay
          const len2 = dx * dx + dy * dy
          const t =
            len2 > 0
              ? THREE.MathUtils.clamp(((px - ax) * dx + (py - ay) * dy) / len2, 0, 1)
              : 0
          const ddx = px - (ax + dx * t)
          const ddy = py - (ay + dy * t)
          const d2 = ddx * ddx + ddy * ddy
          if (d2 < bestD2) {
            bestD2 = d2
            bestId = run.id
            bestPoint.set(
              f[i - 3] + (f[i] - f[i - 3]) * t,
              f[i - 2] + (f[i + 1] - f[i - 2]) * t,
              f[i - 1] + (f[i + 2] - f[i - 1]) * t,
            )
          }
        }
        ax = bx
        ay = by
        aOk = bOk
      }
    }
    if (!bestId) return null
    // Occlusion: march the heightfield toward the picked point; a terrain
    // hit clearly in front of it means a ridge is in the way. The margin
    // absorbs the draping lift and the march's step size.
    const dir = bestPoint.clone().sub(this.camera.position)
    const dist = dir.length()
    const hit = hf.raycast(
      new THREE.Ray(this.camera.position, dir.normalize()),
      this.exag,
      hf.meta.min_elev,
    )
    if (hit && this.camera.position.distanceTo(hit) < dist - Math.max(15, dist * 0.015)) {
      return null
    }
    return bestId
  }

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

    if (this.trackPicking) {
      const trackId = this.pickTrack(e.clientX - rect.left, e.clientY - rect.top, rect)
      if (trackId) {
        this.events.onSelectOverlay(trackId)
        return
      }
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

    const now = performance.now()
    this.trackCameraRest(now)
    if (this.detailFade) {
      const t = Math.min((now - this.detailFade.start) / 300, 1)
      this.drapeUniforms.uDetailFade.value = t
      if (t >= 1) this.detailFade = null
    }

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
    this.detailAbort?.abort()
    this.detailDemAbort?.abort()
    if (this.hillshadeTimer !== null) clearTimeout(this.hillshadeTimer)
    if (this.sunTimer !== null) clearTimeout(this.sunTimer)
    this.lighting?.terminate()
    this.lighting = null
    this.detailTexture?.dispose()
    this.detailShade?.texture.dispose()
    this.hillshadeTexture?.dispose()
    this.aoTexture?.dispose()
    this.material.map?.dispose()
    this.material.dispose()
    this.controls.dispose()
    this.renderer.dispose()
  }
}
