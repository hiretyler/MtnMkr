// Offline standalone viewer. Boots from the JSON payload inlined in the
// exported html, decodes the heightfield, and drives the shared Viewer
// with vanilla DOM chrome. No React, no network - everything it needs
// ships inside the one file.
import { formatDMS, trackLengthKm } from '../geo'
import type { Overlay } from '../types'
import { fmtDistKm, fmtElev, fmtRes, type Units } from '../units'
import { Viewer } from '../viewer'
import { decodeHeights } from './codec'
import { PAYLOAD_SCRIPT_ID, type PayloadLayer, type StandalonePayload } from './payload'
import css from './standalone.css?inline'

// Compass rose copied from the app chrome (App.tsx). The explicit xmlns
// matters: injected via innerHTML in an XHTML document (Apple Books),
// namespace-less svg elements would not render as graphics.
const COMPASS_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 44 44" aria-hidden="true">
  <circle cx="22" cy="22" r="20" fill="none" stroke="#cdc3ac" stroke-width="1" />
  <!-- E / S / W ticks; north gets the letter -->
  <line x1="37" y1="22" x2="41" y2="22" stroke="#6b5f4d" stroke-width="1.5" />
  <line x1="22" y1="37" x2="22" y2="41" stroke="#6b5f4d" stroke-width="1.5" />
  <line x1="3" y1="22" x2="7" y2="22" stroke="#6b5f4d" stroke-width="1.5" />
  <text x="22" y="13" text-anchor="middle" font-size="12" font-family="Barlow Semi Condensed, sans-serif" font-weight="700" fill="#2a2118">N</text>
  <polygon points="22,15 17,23 27,23" fill="#7a4a21" stroke="#2a2118" stroke-width="1" />
  <polygon points="17,23 27,23 22,31" fill="#f6f2e8" stroke="#2a2118" stroke-width="1" />
</svg>`

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function boot(): void {
  const app = document.getElementById('app')
  if (!app) return
  // Surface any startup crash as text. Books renders EPUB pages as strict
  // XHTML where more can throw (innerHTML parses as XML), and there is no
  // console to read on an iPhone.
  try {
    bootInner(app)
  } catch (e) {
    app.textContent = `Viewer failed to start (${e instanceof Error ? e.message : String(e)}).`
  }
}

function bootInner(app: HTMLElement): void {
  let payload: StandalonePayload
  let heights: Float32Array
  try {
    // The .html export inlines the payload as a JSON script block; the
    // .epub export ships it as a sibling payload.js that sets a global
    // (XHTML would XML-parse an inline block, so raw & or < would break it)
    const raw = document.getElementById(PAYLOAD_SCRIPT_ID)?.textContent
    const global = (window as { mtnmkrPayload?: StandalonePayload }).mtnmkrPayload
    if (raw) payload = JSON.parse(raw) as StandalonePayload
    else if (global) payload = global
    else throw new Error('payload block not found')
    heights = decodeHeights(payload.heights)
  } catch (e) {
    app.textContent = `Could not read the terrain data embedded in this file (${
      e instanceof Error ? e.message : String(e)
    }).`
    return
  }

  const style = document.createElement('style')
  style.textContent = css
  document.head.appendChild(style)

  let units: Units = payload.units
  let selectedId: string | null = null
  let measure: { lon: number; lat: number } | null = null

  // Unplaced photos (no GPS fix, never placed on the terrain) have
  // nothing to render and nothing useful to show
  const overlays: Overlay[] = payload.overlays.filter(
    (o) => o.kind === 'track' || (o.lon != null && o.lat != null),
  )

  app.innerHTML = `
    <div class="shell">
      <header class="topbar">
        <div class="top-name"></div>
        <div class="top-meta mono"></div>
      </header>
      <main class="stage">
        <canvas></canvas>
        <button class="compass" title="Face north" aria-label="Face north">
          <div class="rose">${COMPASS_SVG}</div>
        </button>
        <div class="hud mono">Drag to orbit · pinch to zoom · tap terrain to measure</div>
        <button class="toast" hidden=""></button>
        <div class="card" hidden=""></div>
      </main>
      <footer class="bottombar">
        <div class="layers"></div>
        <label class="exag">
          <span class="exag-name">Relief</span>
          <input type="range" min="0.5" max="3" step="0.1" aria-label="Vertical exaggeration" />
          <span class="exag-val mono"></span>
        </label>
        <div class="foot mono"></div>
      </footer>
      <div class="lightbox" hidden=""><img alt="Photo at full size" /></div>
    </div>
  `

  const $ = (sel: string): HTMLElement => app.querySelector(sel) as HTMLElement
  const canvas = app.querySelector('canvas') as HTMLCanvasElement
  const rose = $('.rose')
  const card = $('.card')
  const toast = $('.toast') as HTMLButtonElement
  const lightbox = $('.lightbox')
  const lightboxImg = lightbox.querySelector('img') as HTMLImageElement
  const layersEl = $('.layers')
  const exagInput = $('.exag input') as HTMLInputElement
  const exagVal = $('.exag-val')

  // Apple Books wraps the page in its own pan/zoom scroll view that runs
  // native gestures in parallel with ours; touch-action alone does not
  // stop it. Cancelling touch and WebKit gesture events that target the
  // canvas keeps orbit and pinch inside the 3D stage. Pointer events (all
  // the viewer uses) still fire; other controls keep native behavior.
  for (const type of ['touchstart', 'touchmove']) {
    document.addEventListener(
      type,
      (e) => {
        if (e.target === canvas) e.preventDefault()
      },
      { passive: false },
    )
  }
  for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
    document.addEventListener(type, (e) => {
      if (e.target === canvas) e.preventDefault()
    })
  }

  // ---- static chrome ----------------------------------------------------

  $('.top-name').textContent = payload.center.name ?? 'Terrain'
  const demSource = payload.area.dem_source === 'usgs-3dep' ? 'USGS 3DEP' : 'Terrarium'
  function renderTopMeta(): void {
    $('.top-meta').textContent = [
      formatDMS(payload.center.lat, payload.center.lon),
      demSource,
      fmtRes(payload.area.resolution_m, units),
    ].join(' · ')
  }
  renderTopMeta()

  const exported = new Date(payload.generated)
  $('.foot').textContent = `${payload.attribution} · Exported ${
    isNaN(exported.getTime()) ? payload.generated : exported.toLocaleDateString()
  }`

  let toastTimer = 0
  function showToast(msg: string): void {
    toast.textContent = msg
    toast.hidden = false
    window.clearTimeout(toastTimer)
    toastTimer = window.setTimeout(() => {
      toast.hidden = true
    }, 6000)
  }
  toast.addEventListener('click', () => {
    toast.hidden = true
  })

  // ---- viewer -----------------------------------------------------------

  const viewer = new Viewer(canvas, {
    onPickTerrain: (lon, lat) => {
      measure = { lon, lat }
      if (selectedId) {
        selectedId = null
        viewer.setOverlays(overlays, null)
      }
      renderCard()
    },
    onSelectOverlay: (id) => {
      if (id) measure = null
      selectedId = id
      viewer.setOverlays(overlays, selectedId)
      renderCard()
    },
    onHeadingChange: (roseDeg) => {
      // Direct DOM write - this fires from the render loop
      rose.style.transform = `rotate(${roseDeg}deg)`
    },
  })

  viewer.setTerrain(payload.area, heights)
  viewer.setExaggeration(payload.exaggeration)
  viewer.setOverlays(overlays, null)

  // Summit benchmark: a named peak hill-climbs to its own top, a raw
  // coordinate export marks the area-wide high point
  const hf = viewer.hf!
  const hp = payload.center.name
    ? hf.summitFrom(payload.center.lon, payload.center.lat)
    : hf.highPoint()
  function renderSummit(): void {
    viewer.setSummit({
      lon: hp.lon,
      lat: hp.lat,
      elev: hp.elev,
      label: fmtElev(hp.elev, units),
      name: payload.center.name ?? null,
    })
  }
  renderSummit()

  // ---- layers -----------------------------------------------------------

  function applyLayer(layer: PayloadLayer): void {
    if (layer.kind === 'texture' && layer.dataUrl) {
      viewer
        .setTextureUrl(layer.dataUrl)
        .catch(() => showToast(`Could not load the ${layer.name} layer`))
    } else {
      viewer.setShaded()
    }
    for (const b of layersEl.querySelectorAll('button')) {
      b.classList.toggle('active', b.dataset.id === layer.id)
    }
  }
  for (const layer of payload.layers) {
    const b = el('button', undefined, layer.name)
    b.dataset.id = layer.id
    b.addEventListener('click', () => applyLayer(layer))
    layersEl.appendChild(b)
  }
  const initialLayer =
    payload.layers.find((l) => l.id === payload.initialLayer) ??
    payload.layers.find((l) => l.kind === 'shaded')
  if (initialLayer) applyLayer(initialLayer)
  else viewer.setShaded()

  // ---- exaggeration -----------------------------------------------------

  exagInput.value = String(payload.exaggeration)
  function renderExag(): void {
    exagVal.textContent = `${parseFloat(exagInput.value).toFixed(1)}x`
  }
  exagInput.addEventListener('input', () => {
    viewer.setExaggeration(parseFloat(exagInput.value))
    renderExag()
  })
  renderExag()

  const compassBtn = $('.compass') as HTMLButtonElement
  compassBtn.addEventListener('click', () => viewer.faceNorth())

  // ---- cards ------------------------------------------------------------

  function elevAt(lon: number, lat: number): number | null {
    const sc = viewer.hf?.sceneFromLonLat(lon, lat)
    return sc ? viewer.hf!.heightAt(sc[0], sc[1]) : null
  }

  function closeCard(): void {
    measure = null
    if (selectedId) {
      selectedId = null
      viewer.setOverlays(overlays, null)
    }
    renderCard()
  }

  function unitsToggle(): HTMLElement {
    const wrap = el('div', 'units-toggle')
    for (const u of ['metric', 'imperial'] as const) {
      const b = el('button', units === u ? 'on' : undefined, u === 'metric' ? 'm' : 'ft')
      b.addEventListener('click', () => {
        if (units === u) return
        units = u
        renderTopMeta()
        renderSummit()
        renderCard()
      })
      wrap.appendChild(b)
    }
    return wrap
  }

  function coordLine(lon: number, lat: number): HTMLElement {
    const elev = elevAt(lon, lat)
    return el(
      'div',
      'card-line mono',
      formatDMS(lat, lon) + (elev != null ? ` · ${fmtElev(elev, units)}` : ''),
    )
  }

  function renderCard(): void {
    card.replaceChildren()
    const ov = selectedId ? overlays.find((o) => o.id === selectedId) : undefined
    if (!ov && !measure) {
      card.hidden = true
      return
    }
    card.hidden = false

    const close = el('button', 'card-close', '×')
    close.setAttribute('aria-label', 'Close')
    close.addEventListener('click', closeCard)
    card.appendChild(close)

    if (ov) {
      card.appendChild(el('div', 'card-name', ov.name))
      if (ov.kind === 'photo') {
        const img = el('img', 'card-photo')
        img.src = ov.dataUrl
        img.alt = ov.name
        img.title = 'Tap to enlarge'
        img.addEventListener('click', () => openLightbox(ov.dataUrl))
        card.appendChild(img)
        if (ov.lon != null && ov.lat != null) card.appendChild(coordLine(ov.lon, ov.lat))
      } else if (ov.kind === 'note') {
        if (ov.body) card.appendChild(el('div', 'card-body', ov.body))
        card.appendChild(coordLine(ov.lon, ov.lat))
      } else {
        const pts = ov.segments.reduce((n, s) => n + s.length, 0)
        card.appendChild(
          el(
            'div',
            'card-line mono',
            `${fmtDistKm(trackLengthKm(ov.segments), units)} · ${pts} points`,
          ),
        )
      }
    } else if (measure) {
      card.appendChild(el('div', 'card-name', 'Measured point'))
      card.appendChild(el('div', 'card-line mono', formatDMS(measure.lat, measure.lon)))
      const elev = elevAt(measure.lon, measure.lat)
      if (elev != null) card.appendChild(el('div', 'card-elev', fmtElev(elev, units)))
      card.appendChild(unitsToggle())
    }
  }

  // ---- lightbox ---------------------------------------------------------

  function openLightbox(url: string): void {
    lightboxImg.src = url
    lightbox.hidden = false
  }
  lightbox.addEventListener('click', () => {
    lightbox.hidden = true
  })

  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return
    if (!lightbox.hidden) lightbox.hidden = true
    else if (!card.hidden) closeCard()
  })
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot)
} else {
  boot()
}
