import { textureUrl } from './api'
import { downsampleHeightfield, encodeHeights } from './standalone/codec'
import { PAYLOAD_SCRIPT_ID, type PayloadLayer, type StandalonePayload } from './standalone/payload'
import type { AreaMeta, BaseLayer, CustomLayer, Overlay } from './types'
import type { Units } from './units'

// ---- size estimates (for the export dialog) -----------------------------

/**
 * Rough embedded size of a 2048-px texture data URL, in bytes (includes
 * the 4/3 base64 inflation). Topo and custom layers are PNG, imagery JPEG.
 */
export const TEXTURE_EST_BYTES = {
  topo: 4_500_000,
  imagery: 1_700_000,
  custom: 4_500_000,
} as const

/** Inline viewer runtime (three.js + boot code), rough bytes. */
export const VIEWER_BUNDLE_EST_BYTES = 900_000

/** Quantized 16-bit + gzip + base64 heights for a width x width grid. */
export function estimateHeightsBytes(width: number): number {
  return Math.round(width * width * 2 * 0.55 * (4 / 3))
}

// ---- helpers -------------------------------------------------------------

/** FileReader keeps the blob's MIME and never hits string-length limits. */
function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error ?? new Error('Could not read texture blob'))
    reader.readAsDataURL(blob)
  })
}

async function fetchDataUrl(url: string, what: string): Promise<string> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${what}: fetch failed (${res.status})`)
  return blobToDataUrl(await res.blob())
}

function escapeHtmlText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** btoa over UTF-8 bytes, chunked so multi-MB inputs don't blow the stack. */
function base64OfUtf8(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (let i = 0; i < bytes.length; i += 32768) {
    const sub = bytes.subarray(i, i + 32768)
    binary += String.fromCharCode.apply(null, sub as unknown as number[])
  }
  return btoa(binary)
}

// ---- export --------------------------------------------------------------

export interface StandaloneExportOpts {
  meta: AreaMeta
  center: { lat: number; lon: number; name: string | null }
  heights: Float32Array
  overlays: Overlay[]
  /** subset of 'topo' | 'imagery' | 'custom:<id>' to embed */
  layerIds: string[]
  /** e.g. 1024 phone-friendly, or meta.width for full detail */
  gridTarget: number
  textureSize: number
  units: Units
  exaggeration: number
  activeLayer: BaseLayer
  customLayers: CustomLayer[]
}

export function exportSlug(name: string | null): string {
  return (name ?? 'mtnmkr-project').replace(/[^\w-]+/g, '-').toLowerCase()
}

export function downloadBlob(blob: Blob, filename: string): void {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = filename
  a.click()
  URL.revokeObjectURL(a.href)
}

/**
 * The shared half of every standalone export: assemble the payload and
 * fetch the viewer bundle. The .html and .epub wrappers differ only in
 * packaging.
 */
export async function composeStandalone(
  opts: StandaloneExportOpts,
): Promise<{ payload: StandalonePayload; bundle: string }> {
  // 1. Heights: downsample if asked for less than the loaded grid (the
  // codec returns the inputs unchanged when target >= source), then
  // quantize + gzip + base64 against the post-downsample min/max.
  const ds = downsampleHeightfield(opts.meta, opts.heights, opts.gridTarget)
  const encoded = encodeHeights(ds.data, ds.meta.min_elev, ds.meta.max_elev)
  const heights = {
    ...encoded,
    min: ds.meta.min_elev,
    max: ds.meta.max_elev,
    width: ds.meta.width,
    height: ds.meta.height,
  }

  // 2. Layers: shaded relief is computed from the heights and always ships;
  // texture layers embed as data URLs.
  const layers: PayloadLayer[] = [{ id: 'shaded', name: 'Shaded relief', kind: 'shaded' }]
  for (const id of opts.layerIds) {
    if (id === 'topo' || id === 'imagery') {
      const name = id === 'topo' ? 'USGS topo' : 'Satellite (NAIP)'
      layers.push({
        id,
        name,
        kind: 'texture',
        dataUrl: await fetchDataUrl(textureUrl(opts.meta.id, id, opts.textureSize), name),
      })
    } else if (id.startsWith('custom:')) {
      const cl = opts.customLayers.find((c) => `custom:${c.id}` === id)
      if (!cl) continue
      layers.push({
        id,
        name: cl.name,
        kind: 'texture',
        dataUrl: await fetchDataUrl(cl.url, cl.name),
      })
    }
  }

  // 3. Open on the layer the user is looking at, if it made the cut.
  const initialLayer =
    opts.activeLayer === 'shaded' || opts.layerIds.includes(opts.activeLayer)
      ? opts.activeLayer
      : 'shaded'

  // 4. Only visible overlays; unplaced photos have nowhere to render.
  const overlays = opts.overlays.filter(
    (o) => o.visible && !(o.kind === 'photo' && (o.lon == null || o.lat == null)),
  )

  // 5. Attribution
  const credit = [
    opts.meta.dem_source === 'usgs-3dep' ? 'Terrain: USGS 3DEP' : 'Terrain: Mapzen Terrarium',
  ]
  if (opts.layerIds.includes('topo')) credit.push('Topo: USGS')
  if (opts.layerIds.includes('imagery')) credit.push('Imagery: USDA NAIP')
  credit.push('Made with MtnMkr')

  const payload: StandalonePayload = {
    version: 1,
    generated: new Date().toISOString(),
    units: opts.units,
    area: ds.meta,
    center: opts.center,
    heights,
    layers,
    initialLayer,
    exaggeration: opts.exaggeration,
    overlays,
    attribution: credit.join(' · '),
  }

  // 6. Viewer bundle. In dev an unbuilt bundle falls through to the SPA
  // index (HTML), which would silently export a broken page - catch it.
  const res = await fetch('/standalone-viewer.js')
  const bundle = res.ok ? await res.text() : ''
  if (!res.ok || bundle.trimStart().startsWith('<')) {
    throw new Error('Standalone viewer bundle missing - run npm run build:standalone')
  }

  return { payload, bundle }
}

export async function exportStandaloneHtml(opts: StandaloneExportOpts): Promise<void> {
  const { payload, bundle } = await composeStandalone(opts)

  // 7. `</script` inside the inline bundle would end the tag early.
  // Escaping the slash is a no-op in JS string/regex contexts (\/ === /).
  const sanitized = bundle.replace(/<\/script/gi, '<\\/script')
  const bundleTag = !/<\/script/i.test(sanitized)
    ? `<script>${sanitized}</script>`
    : `<script src="data:text/javascript;base64,${base64OfUtf8(bundle)}"></script>`

  // 8. Escaping every `<` (a legal JSON escape) makes the payload inert to
  // the HTML parser - `</script>` or `<!--<script` in a note body cannot
  // terminate or double-escape the data block.
  const json = JSON.stringify(payload).replace(/</g, '\\u003c')

  const title = escapeHtmlText(payload.center.name ?? 'MtnMkr terrain')

  // 9. Payload before bundle: the viewer reads the JSON block on boot.
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
    <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Cpath d='M4 26 L16 5 L22 15 L25 11 L30 26 Z' fill='%237A4A21'/%3E%3C/svg%3E" />
    <title>${title}</title>
    <style>
      html,
      body {
        margin: 0;
        height: 100%;
      }
      #app {
        height: 100%;
        display: flex;
        align-items: center;
        justify-content: center;
        background: #ede8dc;
        color: #2a2118;
        font-family: system-ui, sans-serif;
      }
      .noscript {
        max-width: 26em;
        padding: 24px;
        line-height: 1.5;
      }
    </style>
  </head>
  <body>
    <div id="app"><div class="boot">Loading terrain…</div><noscript>
      <style>
        .boot {
          display: none;
        }
      </style>
      <div class="noscript">
        <strong>This 3D terrain viewer needs JavaScript, and this preview has it
        turned off.</strong><br /><br />
        iPhone and iPad file previews (AirDrop, Files, Mail) never run scripts.
        Open this file with an HTML viewer app instead: save it to Files, long
        press it, then Share it to an app that renders HTML with JavaScript.
        On a computer, just open the file in any browser.
      </div>
    </noscript></div>
    <script type="application/json" id="${PAYLOAD_SCRIPT_ID}">${json}</script>
    ${bundleTag}
  </body>
</html>
`

  // 10. Download
  downloadBlob(new Blob([html], { type: 'text/html' }), `${exportSlug(payload.center.name)}.html`)
}
