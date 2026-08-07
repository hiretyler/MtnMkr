import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as api from './api'
import {
  estimateHeightsBytes,
  exportStandaloneHtml,
  TEXTURE_EST_BYTES,
  VIEWER_BUNDLE_EST_BYTES,
} from './export'
import { formatDMS, trackLengthKm } from './geo'
import { exportStandaloneEpub } from './epub'
import { parseGpx, parseKml, parseKmz, photoFromFile } from './parsers'
import { exportUsdz } from './usdz'
import { peaksOf, type PeakClass } from './peaks'
import {
  clearSession,
  loadSession,
  requestPersistence,
  saveSession,
  storageInfo,
  type StorageInfo,
} from './store'
import { loadArea, reloadArea, PREBAKE_BASE, type TerrainSource } from './direct/source'
import { findBaked } from './direct/prebake'
import { textureUrl as usgsTextureUrl } from './direct/usgs'
import { search as gazetteerSearch } from './direct/gazetteer'
import { applyUpdate, clearCachedTerrain, onUpdateReady } from './sw-client'
import { elevDisplay, elevTickStep, fmtDistKm, fmtElev, fmtRes, type Units } from './units'
import type {
  AreaMeta,
  BaseLayer,
  Capabilities,
  CustomLayer,
  NoteOverlay,
  Overlay,
  PhotoOverlay,
  ProjectFile,
  SearchResult,
  TrackOverlay,
} from './types'
import { Viewer } from './viewer'

type Mode =
  | { type: 'idle' }
  | { type: 'place-note' }
  | { type: 'place-photo'; id: string }
  | { type: 'move'; id: string }

const TRACK_COLORS = ['#B0413E', '#33638A', '#3F7A44', '#8A5FA0', '#C07A2B', '#2B8A83']
const SIZES = [
  { value: 512, label: '512 - fast' },
  { value: 1024, label: '1024 - standard' },
  { value: 2048, label: '2048 - maximum' },
]

function uid(): string {
  return crypto.randomUUID().slice(0, 8)
}

function shortName(displayName: string): string {
  return displayName.split(',')[0].trim()
}

/** Static asset, so it moves with the app's base path under a subdirectory. */
const GAZETTEER_URL = `${import.meta.env.BASE_URL}gnis_terrain.tsv.gz`

function fmtBytes(n: number): string {
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1048576).toFixed(0)} MB`
  return `${(n / 1073741824).toFixed(1)} GB`
}

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const viewerRef = useRef<Viewer | null>(null)

  const [meta, setMeta] = useState<AreaMeta | null>(null)
  const [overlays, setOverlays] = useState<Overlay[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [layer, setLayer] = useState<BaseLayer>('shaded')
  const [customLayers, setCustomLayers] = useState<CustomLayer[]>([])
  const [exag, setExag] = useState(1)
  const [mode, setMode] = useState<Mode>({ type: 'idle' })
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [lightbox, setLightbox] = useState<string | null>(null)
  const [exportDialog, setExportDialog] = useState(false)
  const [exportLayerIds, setExportLayerIds] = useState<string[]>([])
  const [exportQuality, setExportQuality] = useState<'phone' | 'full'>('phone')
  const [exportFormat, setExportFormat] = useState<'web' | 'epub'>('web')

  const [q, setQ] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [searching, setSearching] = useState(false)
  const [searched, setSearched] = useState(false)
  const [caps, setCaps] = useState<Capabilities | null>(null)
  const [offline, setOffline] = useState(!navigator.onLine)
  const [updateReady, setUpdateReady] = useState(false)
  const [storage, setStorage] = useState<StorageInfo | null>(null)
  // Absolute texture URLs for the current area - pre-baked, backend, or
  // straight from USGS. The layer effect no longer needs to know which.
  const [textures, setTextures] = useState<{ topo: string; imagery: string } | null>(null)
  const [terrainSource, setTerrainSource] = useState<TerrainSource | null>(null)
  // Off by default: worldwide search leaves the bundled public-domain index
  // and hits komoot's Photon demo API, whose terms only cover light use.
  const [worldwide, setWorldwide] = useState(false)
  const [peakIndex, setPeakIndex] = useState<PeakClass | null>(null)
  const [units, setUnits] = useState<Units>(() =>
    localStorage.getItem('mtnmkr-units') === 'imperial' ? 'imperial' : 'metric',
  )
  // Hillshade strength over the topo/imagery drape, in whole percent.
  // Validated on read - never trust localStorage.
  const [relief, setRelief] = useState<number>(() => {
    const v = parseInt(localStorage.getItem('mtnmkr-relief') ?? '', 10)
    return Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : 35
  })
  const [radiusKm, setRadiusKm] = useState(4)
  const [size, setSize] = useState(1024)
  const [center, setCenter] = useState<{ lat: number; lon: number; name: string | null } | null>(
    null,
  )

  const modeRef = useRef(mode)
  modeRef.current = mode
  const overlaysRef = useRef(overlays)
  overlaysRef.current = overlays
  const trackCount = useRef(0)
  const searchWrapRef = useRef<HTMLDivElement>(null)
  const roseRef = useRef<HTMLDivElement>(null)

  // Probed once. A deployment with no backend simply resolves to null, and
  // everything that needs one (GeoTIFF upload, worldwide search) hides itself.
  const capsRef = useRef<Promise<Capabilities | null>>(
    api.fetchCapabilities().then(
      (c) => c,
      () => null,
    ),
  )

  const showError = useCallback((e: unknown) => {
    // Non-Error rejections stringify to noise - a TextureLoader rejects with
    // the image's error Event, which String() renders as "[object Event]".
    setError(
      e instanceof Error
        ? e.message
        : typeof e === 'string'
          ? e
          : 'A network request failed - check the connection and try again.',
    )
  }, [])

  const updateOverlay = useCallback((id: string, patch: Partial<Overlay>) => {
    setOverlays((prev) => prev.map((o) => (o.id === id ? ({ ...o, ...patch } as Overlay) : o)))
  }, [])

  // ---- viewer lifecycle -------------------------------------------------

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const viewer = new Viewer(canvas, {
      onPickTerrain: (lon, lat) => {
        const m = modeRef.current
        if (m.type === 'place-note') {
          const note: NoteOverlay = {
            id: uid(),
            kind: 'note',
            name: 'Trip note',
            visible: true,
            lon,
            lat,
            body: '',
          }
          setOverlays((prev) => [...prev, note])
          setSelectedId(note.id)
          setMode({ type: 'idle' })
        } else if (m.type === 'place-photo' || m.type === 'move') {
          updateOverlay(m.id, { lon, lat })
          setSelectedId(m.id)
          setMode({ type: 'idle' })
        } else {
          setSelectedId(null)
        }
      },
      onSelectOverlay: (id) => {
        if (modeRef.current.type === 'idle') setSelectedId(id)
      },
      onHeadingChange: (roseDeg) => {
        // Direct DOM write - this fires from the render loop
        if (roseRef.current) roseRef.current.style.transform = `rotate(${roseDeg}deg)`
      },
    })
    viewerRef.current = viewer
    return () => {
      viewer.dispose()
      viewerRef.current = null
    }
  }, [updateOverlay])

  useEffect(() => {
    viewerRef.current?.setOverlays(overlays, selectedId)
  }, [overlays, selectedId, meta, exag])

  useEffect(() => {
    viewerRef.current?.setExaggeration(exag)
  }, [exag])

  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer || !meta) return
    if (layer === 'shaded') {
      viewer.setShaded()
      viewer.setDrapeKind(null)
    } else if (layer === 'topo' || layer === 'imagery') {
      viewer.setDrapeKind(layer)
      if (textures) {
        const url = textures[layer]
        const label = layer === 'topo' ? 'USGS topo' : 'satellite'
        viewer.setTextureUrl(url).catch(() => {
          // A pre-baked texture can vanish when a bake is retired; the meta
          // always has the bbox, so the same layer can be fetched live.
          const live = usgsTextureUrl(meta.bbox3857, layer)
          if (live === url) {
            showError(new Error(`The ${label} layer failed to load.`))
            return
          }
          viewer
            .setTextureUrl(live)
            .then(() => setTextures((prev) => (prev ? { ...prev, [layer]: live } : prev)))
            .catch(() => showError(new Error(`The ${label} layer failed to load.`)))
        })
      }
    } else {
      viewer.setDrapeKind(null)
      const id = layer.slice('custom:'.length)
      const cl = customLayers.find((c) => c.id === id)
      if (cl) viewer.setTextureUrl(cl.url).catch(showError)
    }
  }, [layer, meta, textures, customLayers, showError])

  useEffect(() => {
    if (!error) return
    const t = setTimeout(() => setError(null), 8000)
    return () => clearTimeout(t)
  }, [error])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setMode({ type: 'idle' })
        setResults([])
        setSearched(false)
        setPeakIndex(null)
        setLightbox(null)
        setExportDialog(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    localStorage.setItem('mtnmkr-units', units)
  }, [units])

  useEffect(() => {
    viewerRef.current?.setReliefStrength(relief / 100)
    // Persist debounced - the slider fires per pixel of drag
    const t = setTimeout(() => localStorage.setItem('mtnmkr-relief', String(relief)), 200)
    return () => clearTimeout(t)
  }, [relief])

  // Summit benchmark. For a named peak, hill-climb from its coordinates
  // to the local maximum - the peak the user asked for, never a taller
  // neighbor (reaching one would mean descending a saddle first). Raw
  // coordinate loads mark the area-wide high point instead.
  useEffect(() => {
    const viewer = viewerRef.current
    const hf = viewer?.hf
    if (!meta || !viewer || !hf) return
    const hp = center?.name ? hf.summitFrom(center.lon, center.lat) : hf.highPoint()
    viewer.setSummit({
      lon: hp.lon,
      lat: hp.lat,
      elev: hp.elev,
      label: fmtElev(hp.elev, units),
      name: center?.name ?? null,
    })
  }, [meta, units, center])

  // Close the search dropdown on any press outside it
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (searchWrapRef.current && !searchWrapRef.current.contains(e.target as Node)) {
        setResults([])
        setSearched(false)
        setPeakIndex(null)
      }
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [])

  // ---- terrain loading --------------------------------------------------

  const loadAreaAt = useCallback(
    async (lat: number, lon: number, name: string | null, r?: number, s?: number) => {
      let radius = r ?? radiusKm
      let px = s ?? size
      // Terrain centre. For a pre-baked summit this becomes the published
      // tile's centre, which for a grouped tile is not the summit itself;
      // `center` stays on the summit the user asked for, so the benchmark
      // hill-climb still starts from the right peak.
      let at = { lat, lon }
      setCenter({ lat, lon, name })
      setBusy('Locating terrain...')
      try {
        // A summit covered by the pre-bake opens as its published tile - the
        // predictable-latency path the bake exists for. An explicit radius or
        // grid that differs from the baked one is a deliberate custom build
        // and takes the live path.
        if (PREBAKE_BASE) {
          const baked = await findBaked(PREBAKE_BASE, lat, lon)
          if (
            baked &&
            ((r === undefined && s === undefined) ||
              (r === baked.radius_km && s === baked.size))
          ) {
            radius = baked.radius_km
            px = baked.size
            at = { lat: baked.lat, lon: baked.lon }
          }
        }
        setRadiusKm(radius)
        setSize(px)
        const got = await loadArea(at.lat, at.lon, radius, px, name, await capsRef.current, setBusy)
        const m = got.meta
        viewerRef.current?.setTerrain(m, got.heights)
        setMeta(m)
        setTextures(got.textures)
        setTerrainSource(got.source)
        setCustomLayers([])
        if (layer.startsWith('custom:')) setLayer('shaded')
        const hash = `lat=${lat.toFixed(5)}&lon=${lon.toFixed(5)}&r=${radius}&s=${px}${
          name ? `&name=${encodeURIComponent(name)}` : ''
        }`
        lastHashRef.current = hash
        location.hash = hash
      } catch (e) {
        showError(e)
      } finally {
        setBusy(null)
      }
    },
    [radiusKm, size, layer, showError],
  )

  /**
   * Re-open an already-resolved area without asking the server to resolve it
   * again. The heightmap request is a GET the service worker can serve from
   * cache, so this is the path that works with no signal.
   */
  const restoreArea = useCallback(
    async (m: AreaMeta, name: string | null, at?: { lat: number; lon: number } | null) => {
      // `at` is the summit the session was looking at; on a grouped pre-baked
      // tile that is not the tile's centre, and the benchmark hill-climb has
      // to start from the summit.
      const c = at ?? { lat: m.lat, lon: m.lon }
      setCenter({ lat: c.lat, lon: c.lon, name })
      setBusy('Loading cached terrain...')
      try {
        const got = await reloadArea(m, await capsRef.current)
        viewerRef.current?.setTerrain(got.meta, got.heights)
        setMeta(got.meta)
        setTextures(got.textures)
        setTerrainSource(got.source)
        const hash = `lat=${c.lat.toFixed(5)}&lon=${c.lon.toFixed(5)}&r=${m.radius_km}&s=${
          m.size
        }${name ? `&name=${encodeURIComponent(name)}` : ''}`
        lastHashRef.current = hash
        location.hash = hash
      } catch (e) {
        showError(e)
      } finally {
        setBusy(null)
      }
    },
    [showError],
  )

  const didInit = useRef(false)
  const lastHashRef = useRef('')
  // Suppresses the persistence write until the restore pass has run, so an
  // empty initial state cannot clobber a saved session before it loads.
  const restored = useRef(false)
  const loadFromHash = useCallback(() => {
    const p = new URLSearchParams(location.hash.slice(1))
    const lat = parseFloat(p.get('lat') ?? '')
    const lon = parseFloat(p.get('lon') ?? '')
    if (!isFinite(lat) || !isFinite(lon)) return
    const r = parseFloat(p.get('r') ?? '') || 4
    const s = parseInt(p.get('s') ?? '') || 1024
    setRadiusKm(r)
    setSize(s)
    void loadAreaAt(lat, lon, p.get('name'), r, s)
  }, [loadAreaAt])

  // Boot: restore the saved session, then let the URL hash win on the area if
  // it names one. Overlays are restored either way - tracks and photos belong
  // to the trip, not to whichever peak the link happened to point at.
  useEffect(() => {
    if (didInit.current) return
    didInit.current = true
    void (async () => {
      const saved = await loadSession()
      if (saved) {
        if (saved.overlays.length) setOverlays(saved.overlays)
        setLayer(saved.layer)
        setExag(saved.exaggeration)
        setUnits(saved.units)
      }
      const p = new URLSearchParams(location.hash.slice(1))
      const hashLat = parseFloat(p.get('lat') ?? '')
      const hashLon = parseFloat(p.get('lon') ?? '')
      const hasHash = isFinite(hashLat) && isFinite(hashLon)
      // The saved meta is reusable when the hash points at the same area (or
      // there is no hash at all) - that is the case that has to work offline.
      // The hash (like the saved area) names the summit the user was looking
      // at, which on a grouped pre-baked tile is not the tile's centre - so
      // compare against the saved summit, falling back to the tile centre.
      const savedLat = saved?.area?.lat ?? saved?.meta?.lat ?? NaN
      const savedLon = saved?.area?.lon ?? saved?.meta?.lon ?? NaN
      const sameArea =
        saved?.meta != null &&
        (!hasHash ||
          (Math.abs(savedLat - hashLat) < 1e-5 &&
            Math.abs(savedLon - hashLon) < 1e-5 &&
            saved.meta.radius_km === (parseFloat(p.get('r') ?? '') || 4) &&
            saved.meta.size === (parseInt(p.get('s') ?? '') || 1024)))

      if (saved?.meta && sameArea) {
        setRadiusKm(saved.meta.radius_km)
        setSize(saved.meta.size)
        await restoreArea(saved.meta, saved.area?.name ?? p.get('name'), saved.area)
      } else if (hasHash) {
        loadFromHash()
      }
      restored.current = true
    })()
  }, [loadFromHash, restoreArea])

  // Persist the session. Debounced because overlay edits fire on every drag
  // of a marker-size slider, and photos make each write non-trivial.
  useEffect(() => {
    if (!restored.current) return
    const t = window.setTimeout(() => {
      void saveSession({
        area: center
          ? {
              lat: center.lat,
              lon: center.lon,
              radius_km: meta?.radius_km ?? radiusKm,
              size: meta?.size ?? size,
              name: center.name,
            }
          : null,
        meta,
        layer,
        exaggeration: exag,
        overlays,
        units,
      })
    }, 600)
    return () => window.clearTimeout(t)
  }, [center, meta, radiusKm, size, layer, exag, overlays, units])

  // Offline status, storage headroom, and the update prompt
  useEffect(() => {
    onUpdateReady(() => setUpdateReady(true))
    const sync = () => setOffline(!navigator.onLine)
    window.addEventListener('online', sync)
    window.addEventListener('offline', sync)
    void storageInfo().then(setStorage)
    return () => {
      window.removeEventListener('online', sync)
      window.removeEventListener('offline', sync)
    }
  }, [])

  // Editing the hash by hand (or following an in-page link) rebuilds the
  // terrain; our own hash writes in loadAreaAt are ignored via lastHashRef
  useEffect(() => {
    const onHash = () => {
      if (location.hash.slice(1) === lastHashRef.current) return
      loadFromHash()
    }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [loadFromHash])

  // Ask the backend what this build supports. A packaged binary may ship
  // without GDAL, so the GeoTIFF control is feature-detected rather than
  // offered unconditionally and failing server-side.
  useEffect(() => {
    capsRef.current.then(setCaps)
  }, [])

  const onSearch = async (e: React.FormEvent) => {
    e.preventDefault()
    const query = q.trim()
    if (!query) return
    // Direct "lat, lon" entry
    const m = query.match(/^(-?\d+(?:\.\d+)?)[,\s]+(-?\d+(?:\.\d+)?)$/)
    if (m) {
      void loadAreaAt(parseFloat(m[1]), parseFloat(m[2]), null)
      return
    }
    setPeakIndex(null)
    setSearching(true)
    setResults([])
    setSearched(false)
    try {
      // Worldwide search is the only query that still needs a server; the
      // bundled gazetteer covers the US in-browser and works offline.
      setResults(
        worldwide && caps
          ? await api.search(query, true)
          : await gazetteerSearch(query, GAZETTEER_URL),
      )
      setSearched(true)
    } catch (err) {
      showError(err)
    } finally {
      setSearching(false)
    }
  }

  // ---- data imports -----------------------------------------------------

  const addTrackFiles = async (files: FileList | File[]) => {
    for (const file of Array.from(files)) {
      try {
        const lower = file.name.toLowerCase()
        const parsed = lower.endsWith('.kmz')
          ? parseKmz(await file.arrayBuffer())
          : lower.endsWith('.kml')
            ? parseKml(await file.text())
            : parseGpx(await file.text())
        const added: Overlay[] = []
        for (const t of parsed.tracks) {
          added.push({
            id: uid(),
            kind: 'track',
            name: t.name === 'GPX track' || t.name === 'KML feature' ? file.name : t.name,
            color: TRACK_COLORS[trackCount.current++ % TRACK_COLORS.length],
            visible: true,
            segments: t.segments,
            source: file.name,
          } satisfies TrackOverlay)
        }
        for (const pt of parsed.points) {
          added.push({
            id: uid(),
            kind: 'note',
            name: pt.name,
            visible: true,
            lon: pt.lon,
            lat: pt.lat,
            body: pt.body,
            source: file.name,
          } satisfies NoteOverlay)
        }
        if (added.length === 0) {
          setError(`${file.name}: no tracks or waypoints found`)
        } else {
          setOverlays((prev) => [...prev, ...added])
        }
      } catch (e) {
        showError(`${file.name}: ${e instanceof Error ? e.message : e}`)
      }
    }
  }

  const addPhotoFiles = async (files: FileList | File[]) => {
    let firstUnplaced: string | null = null
    let unplaced = 0
    let dupes = 0
    for (const file of Array.from(files)) {
      try {
        const p = await photoFromFile(file)
        const exists = overlaysRef.current.some(
          (o) => o.kind === 'photo' && o.name === p.name && o.dataUrl === p.dataUrl,
        )
        if (exists) {
          dupes++
          continue
        }
        const photo: PhotoOverlay = {
          id: uid(),
          kind: 'photo',
          name: p.name,
          visible: true,
          lon: p.lon,
          lat: p.lat,
          dataUrl: p.dataUrl,
        }
        if (p.lon == null) {
          unplaced++
          firstUnplaced ??= photo.id
        }
        setOverlays((prev) => [...prev, photo])
      } catch (e) {
        showError(e)
      }
    }
    if (dupes > 0) {
      setError(`Skipped ${dupes} photo${dupes > 1 ? 's' : ''} already in the project.`)
    }
    if (firstUnplaced) {
      // Surface the placement flow: select it so the photo panel with
      // "Place on terrain" opens immediately
      setSelectedId(firstUnplaced)
      setError(
        `${unplaced > 1 ? `${unplaced} photos have` : 'That photo has'} no GPS tag - use "Place on terrain" in the photo panel, then click the map.`,
      )
    }
  }

  const addGeoTiff = async (file: File) => {
    if (!meta) return
    setBusy(`Warping ${file.name} onto the terrain...`)
    try {
      const res = await api.uploadGeoTiff(meta.id, file)
      const cl: CustomLayer = { id: res.layer_id, name: res.name, url: res.url }
      setCustomLayers((prev) => [...prev.filter((c) => c.id !== cl.id), cl])
      setLayer(`custom:${cl.id}`)
    } catch (e) {
      showError(e)
    } finally {
      setBusy(null)
    }
  }

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    const files = Array.from(e.dataTransfer.files)
    const tracks = files.filter((f) => /\.(gpx|kml|kmz)$/i.test(f.name))
    const photos = files.filter((f) => /\.(jpe?g|png|webp)$/i.test(f.name))
    const tiffs = files.filter((f) => /\.(tiff?)$/i.test(f.name))
    if (tracks.length) void addTrackFiles(tracks)
    if (photos.length) void addPhotoFiles(photos)
    if (tiffs.length) void addGeoTiff(tiffs[0])
  }

  // ---- project save / load ----------------------------------------------

  const exportProject = () => {
    if (!meta || !center) return
    const pf: ProjectFile = {
      version: 1,
      area: {
        lat: center.lat,
        lon: center.lon,
        radius_km: meta.radius_km,
        size: meta.size,
        name: center.name,
      },
      layer: layer.startsWith('custom:') ? 'shaded' : layer,
      exaggeration: exag,
      overlays,
    }
    const blob = new Blob([JSON.stringify(pf)], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `${(center.name ?? 'mtnmkr-project').replace(/[^\w-]+/g, '-').toLowerCase()}.mtnmkr.json`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  const importProject = async (file: File) => {
    try {
      const pf = JSON.parse(await file.text()) as ProjectFile
      if (pf.version !== 1) throw new Error('Unsupported project file version')
      setRadiusKm(pf.area.radius_km)
      setSize(pf.area.size)
      setExag(pf.exaggeration)
      await loadAreaAt(pf.area.lat, pf.area.lon, pf.area.name, pf.area.radius_km, pf.area.size)
      setOverlays(pf.overlays)
      setLayer(pf.layer)
    } catch (e) {
      showError(e)
    }
  }

  const openExportDialog = () => {
    // Fresh dialog state on every open; pre-check the layer on screen
    setExportLayerIds(layer !== 'shaded' ? [layer] : [])
    setExportQuality('phone')
    setExportFormat('web')
    setExportDialog(true)
  }

  const toggleExportLayer = (id: string) => {
    setExportLayerIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    )
  }

  const exportPage = async () => {
    const hfNow = viewerRef.current?.hf
    if (!meta || !center || !hfNow) return
    setExportDialog(false)
    setBusy(exportFormat === 'epub' ? 'Building ePub...' : 'Building web page...')
    try {
      const exportOpts = {
        meta,
        center,
        heights: hfNow.data,
        overlays,
        layerIds: exportLayerIds,
        gridTarget: exportQuality === 'full' ? meta.width : 1024,
        textureSize: 2048,
        units,
        exaggeration: exag,
        activeLayer: layer,
        customLayers,
      }
      if (exportFormat === 'epub') await exportStandaloneEpub(exportOpts)
      else await exportStandaloneHtml(exportOpts)
    } catch (e) {
      showError(e)
    } finally {
      setBusy(null)
    }
  }

  const exportUsdzFile = async () => {
    const viewer = viewerRef.current
    const hfNow = viewer?.hf
    if (!meta || !center || !viewer || !hfNow) return
    setBusy('Building USDZ...')
    try {
      await exportUsdz({
        meta,
        center,
        heights: hfNow.data,
        overlays,
        activeLayer: layer,
        customLayers,
        exaggeration: exag,
        summit: viewer.summitInfo,
      })
    } catch (e) {
      showError(e)
    } finally {
      setBusy(null)
    }
  }

  // ---- derived ----------------------------------------------------------

  const classPeaks = useMemo(() => (peakIndex ? peaksOf(peakIndex) : []), [peakIndex])
  const shownPeaks = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return needle ? classPeaks.filter((p) => p.n.toLowerCase().includes(needle)) : classPeaks
  }, [classPeaks, q])

  const toggleIndex = (cls: PeakClass) => {
    setResults([])
    setSearched(false)
    setQ('')
    setPeakIndex((prev) => (prev === cls ? null : cls))
  }

  /**
   * Overlays grouped by importing file; hand-added items have no source
   * and always render first so a freshly added photo or note is never
   * buried under a long waypoint list.
   */
  const grouped = useMemo(() => {
    const order: { source: string | null; items: Overlay[] }[] = []
    const index = new Map<string | null, { source: string | null; items: Overlay[] }>()
    for (const o of overlays) {
      const key = o.source ?? null
      let g = index.get(key)
      if (!g) {
        g = { source: key, items: [] }
        index.set(key, g)
        order.push(g)
      }
      g.items.push(o)
    }
    return [...order.filter((g) => g.source === null), ...order.filter((g) => g.source !== null)]
  }, [overlays])

  const setGroupScale = (source: string, v: number) => {
    setOverlays((prev) =>
      prev.map((o) =>
        o.source === source && (o.kind === 'note' || o.kind === 'photo')
          ? { ...o, scale: v }
          : o,
      ),
    )
  }

  const setGroupWaypointsVisible = (source: string, visible: boolean) => {
    setOverlays((prev) =>
      prev.map((o) =>
        o.source === source && o.kind !== 'track' ? { ...o, visible } : o,
      ),
    )
  }

  /** Ballpark size of the standalone export, for the dialog. */
  const exportEstMb = useMemo(() => {
    if (!meta) return 0
    const grid = exportQuality === 'full' ? meta.width : Math.min(1024, meta.width)
    let bytes = VIEWER_BUNDLE_EST_BYTES + estimateHeightsBytes(grid)
    for (const id of exportLayerIds) {
      bytes +=
        id === 'topo'
          ? TEXTURE_EST_BYTES.topo
          : id === 'imagery'
            ? TEXTURE_EST_BYTES.imagery
            : TEXTURE_EST_BYTES.custom
    }
    for (const o of overlays) {
      if (o.kind === 'photo' && o.visible && o.lon != null) {
        bytes += (o.dataUrl.length * 3) / 4
      }
    }
    return bytes / 1e6
  }, [meta, exportQuality, exportLayerIds, overlays])

  const selected = overlays.find((o) => o.id === selectedId) ?? null
  const hf = viewerRef.current?.hf ?? null
  const elevOf = (lon: number | null, lat: number | null): number | null => {
    if (lon == null || lat == null || !hf) return null
    const sc = hf.sceneFromLonLat(lon, lat)
    return sc ? hf.heightAt(sc[0], sc[1]) : null
  }

  const hint =
    mode.type === 'place-note'
      ? 'Click the terrain to drop the note. Esc cancels.'
      : mode.type === 'place-photo' || mode.type === 'move'
        ? 'Click the terrain to set the location. Esc cancels.'
        : meta
          ? 'Drag to pan · right-drag to rotate · scroll to zoom'
          : 'Search for a peak to build its terrain'

  const trackInput = useRef<HTMLInputElement>(null)
  const photoInput = useRef<HTMLInputElement>(null)
  const tiffInput = useRef<HTMLInputElement>(null)
  const projectInput = useRef<HTMLInputElement>(null)

  // ---- render -----------------------------------------------------------

  return (
    <div className="app" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
      <aside className="panel">
        <header className="masthead">
          <h1>MtnMkr</h1>
        </header>

        {offline && (
          <div className="banner offline-banner">
            Offline - cached peaks still work. Search and new terrain need a
            connection.
          </div>
        )}
        {updateReady && (
          <div className="banner update-banner">
            <span>A new version is ready.</span>
            <button onClick={applyUpdate}>Reload</button>
          </div>
        )}

        <section>
          <div className="sec-head">
            <h2>Locate</h2>
            <div className="units-toggle" role="group" aria-label="Units">
              <button
                className={units === 'metric' ? 'on' : ''}
                onClick={() => setUnits('metric')}
              >
                km·m
              </button>
              <button
                className={units === 'imperial' ? 'on' : ''}
                onClick={() => setUnits('imperial')}
              >
                mi·ft
              </button>
            </div>
          </div>
          <div className="search-wrap" ref={searchWrapRef}>
            <form onSubmit={onSearch} className="search-row">
              <input
                value={q}
                onChange={(e) => {
                  setQ(e.target.value)
                  setSearched(false)
                }}
                placeholder={
                  peakIndex
                    ? 'Filter the list'
                    : worldwide
                      ? 'Peak name (worldwide) or "lat, lon"'
                      : 'Peak name or "lat, lon"'
                }
                aria-label="Search for a peak"
              />
              <button type="submit" disabled={searching}>
                {searching ? '...' : 'Find'}
              </button>
            </form>
            <label className="worldwide-row" hidden={!caps}>
              <input
                type="checkbox"
                checked={worldwide}
                onChange={(e) => {
                  setWorldwide(e.target.checked)
                  setResults([])
                  setSearched(false)
                }}
              />
              <span>Search worldwide</span>
            </label>
            {worldwide && (
              <p className="worldwide-note">
                Worldwide search queries komoot's public Photon service instead of
                the bundled USGS index. It is a demo endpoint with no uptime
                guarantee - heavy use is throttled or blocked, and results outside
                the US only get ~30 m elevation anyway. Leave it off unless you
                need a peak beyond the United States.
              </p>
            )}
            <div className="index-row">
              <span className="index-label">Colorado index</span>
              <button
                className={peakIndex === '14' ? 'active' : ''}
                onClick={() => toggleIndex('14')}
              >
                14ers
              </button>
              <button
                className={peakIndex === '13' ? 'active' : ''}
                onClick={() => toggleIndex('13')}
              >
                13ers
              </button>
            </div>
            {(peakIndex !== null || results.length > 0 || (searched && results.length === 0)) && (
              <ul className="results">
                {peakIndex !== null && (
                  <>
                    <li className="list-head mono">
                      {shownPeaks.length === classPeaks.length
                        ? `${classPeaks.length} peaks`
                        : `${shownPeaks.length} of ${classPeaks.length} peaks`}
                      {peakIndex === '14' ? ' ≥ 14,000 ft' : ' 13,000-13,999 ft'} · USGS GNIS
                    </li>
                    {shownPeaks.map((p) => (
                      <li key={`${p.n}:${p.lat}`}>
                        <button
                          onClick={() => {
                            setPeakIndex(null)
                            setQ(p.n)
                            void loadAreaAt(p.lat, p.lon, p.n)
                          }}
                        >
                          <span className="result-name">{p.n}</span>
                          <span className="result-detail">{fmtElev(p.e, units)}</span>
                        </button>
                      </li>
                    ))}
                    {shownPeaks.length === 0 && (
                      <li className="no-hit">No peaks match that filter.</li>
                    )}
                  </>
                )}
                {results.map((r, i) => (
                  <li key={i}>
                    <button
                      onClick={() => {
                        setResults([])
                        setSearched(false)
                        setQ(shortName(r.name))
                        void loadAreaAt(r.lat, r.lon, shortName(r.name))
                      }}
                    >
                      <span className="result-name">{shortName(r.name)}</span>
                      <span className="result-detail">
                        {r.type} · {r.name.split(',').slice(1, 3).join(',')}
                      </span>
                    </button>
                  </li>
                ))}
                {searched && results.length === 0 && (
                  <li className="no-hit">
                    No mountains or terrain features found. Try a peak name, or
                    paste "lat, lon".
                  </li>
                )}
              </ul>
            )}
          </div>
          <label className="field">
            <span>
              Radius <em className="mono">{fmtDistKm(radiusKm, units)}</em>
            </span>
            <input
              type="range"
              min={1}
              max={15}
              step={0.5}
              value={radiusKm}
              onChange={(e) => setRadiusKm(parseFloat(e.target.value))}
            />
          </label>
          <label className="field">
            <span>Grid detail</span>
            <select value={size} onChange={(e) => setSize(parseInt(e.target.value))}>
              {SIZES.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
          {center && (
            <button
              className="primary"
              onClick={() => void loadAreaAt(center.lat, center.lon, center.name, radiusKm, size)}
            >
              Rebuild terrain
            </button>
          )}
        </section>

        {meta && (
          <section className="sheet">
            <h2>Peak Data</h2>
            <div className="sheet-name">{center?.name ?? 'Unnamed area'}</div>
            <div className="mono sheet-line">{formatDMS(meta.lat, meta.lon)}</div>
            <div className="mono sheet-line">
              {meta.dem_source === 'usgs-3dep' ? 'USGS 3DEP lidar/DEM' : 'Terrarium 30 m (non-US)'}
              {' · '}
              {fmtRes(meta.resolution_m, units)}
            </div>
            <HypsoStrip min={meta.min_elev} max={meta.max_elev} units={units} />
          </section>
        )}

        <section>
          <h2>Layers</h2>
          <div className="layer-list" role="radiogroup" aria-label="Base layer">
            {(
              [
                ['shaded', 'Shaded relief'],
                ['topo', 'USGS topo'],
                ['imagery', 'Satellite (NAIP)'],
              ] as [BaseLayer, string][]
            )
              .concat(customLayers.map((c) => [`custom:${c.id}` as BaseLayer, c.name]))
              .map(([value, label]) => (
                <label key={value} className={layer === value ? 'layer on' : 'layer'}>
                  <input
                    type="radio"
                    name="layer"
                    checked={layer === value}
                    disabled={!meta}
                    onChange={() => setLayer(value)}
                  />
                  {label}
                </label>
              ))}
          </div>
          {/* Only when a backend actually reported it. A null caps means no
              backend at all, and the upload would have nowhere to go. */}
          {caps?.geotiff === true && (
            <button disabled={!meta} onClick={() => tiffInput.current?.click()}>
              Add GeoTIFF layer
            </button>
          )}
          <label className="field">
            <span>
              Relief <em className="mono">{relief}%</em>
            </span>
            <input
              type="range"
              min={0}
              max={100}
              step={1}
              value={relief}
              disabled={!meta || layer === 'shaded' || layer.startsWith('custom:')}
              onChange={(e) => setRelief(parseInt(e.target.value, 10))}
            />
          </label>
          <label className="field">
            <span>
              Vertical exaggeration <em className="mono">{exag.toFixed(1)}x</em>
            </span>
            <input
              type="range"
              min={0.5}
              max={3}
              step={0.1}
              value={exag}
              onChange={(e) => setExag(parseFloat(e.target.value))}
            />
          </label>
        </section>

        <section>
          <h2>Trip data</h2>
          <div className="btn-row">
            <button disabled={!meta} onClick={() => trackInput.current?.click()}>
              Tracks
            </button>
            <button disabled={!meta} onClick={() => photoInput.current?.click()}>
              Photos
            </button>
            <button
              disabled={!meta}
              className={mode.type === 'place-note' ? 'active' : ''}
              onClick={() => setMode({ type: 'place-note' })}
            >
              Note
            </button>
          </div>
          {overlays.length === 0 ? (
            <div className="empty">
              Drop GPX, KML/KMZ, photos, or a GeoTIFF anywhere on the page.
            </div>
          ) : (
            <ul className="data-list">
              {grouped.map((g) => {
                const rows = g.items.map((o) => (
                  <li key={o.id} className={o.id === selectedId ? 'selected' : ''}>
                    <button
                      className="eye"
                      title={o.visible ? 'Hide' : 'Show'}
                      onClick={() => updateOverlay(o.id, { visible: !o.visible })}
                    >
                      {o.visible ? '●' : '○'}
                    </button>
                    <button className="data-name" onClick={() => setSelectedId(o.id)}>
                      {o.kind === 'track' && (
                        <span className="chip" style={{ background: o.color }} />
                      )}
                      {o.kind === 'photo' && <span className="glyph">▣</span>}
                      {o.kind === 'note' && <span className="glyph">✚</span>}
                      <span className="label">{o.name}</span>
                      {o.kind === 'photo' && o.lon == null && (
                        <span className="unplaced">unplaced</span>
                      )}
                    </button>
                    <button
                      className="del"
                      title="Remove"
                      onClick={() => {
                        setOverlays((prev) => prev.filter((x) => x.id !== o.id))
                        if (selectedId === o.id) setSelectedId(null)
                      }}
                    >
                      ✕
                    </button>
                  </li>
                ))
                if (g.source === null) return <Fragment key="ungrouped">{rows}</Fragment>
                const waypoints = g.items.filter((o) => o.kind !== 'track') as (
                  | NoteOverlay
                  | PhotoOverlay
                )[]
                const allWptsVisible =
                  waypoints.length > 0 && waypoints.every((o) => o.visible)
                return (
                  <Fragment key={`g:${g.source}`}>
                    <li className="group-head">
                      {waypoints.length > 0 && (
                        <button
                          className="eye"
                          title={
                            allWptsVisible
                              ? 'Hide all waypoints from this file'
                              : 'Show all waypoints from this file'
                          }
                          onClick={() =>
                            setGroupWaypointsVisible(g.source!, !allWptsVisible)
                          }
                        >
                          {allWptsVisible ? '●' : '○'}
                        </button>
                      )}
                      <span className="group-name">{g.source}</span>
                      {waypoints.length > 0 && (
                        <input
                          type="range"
                          min={0.1}
                          max={2}
                          step={0.05}
                          value={waypoints[0].scale ?? 1}
                          onChange={(e) =>
                            setGroupScale(g.source!, parseFloat(e.target.value))
                          }
                          title="Waypoint marker size"
                          aria-label={`Waypoint marker size for ${g.source}`}
                        />
                      )}
                    </li>
                    {rows}
                  </Fragment>
                )
              })}
            </ul>
          )}
        </section>

        <section>
          <h2>Offline</h2>
          <p className="offline-note">
            Peaks you open are cached on this device, and your tracks, photos, and
            notes are saved as you go - so a reload with no signal still works.
            On iPhone, use Share &rarr; Add to Home Screen: Safari wipes cached
            data after 7 days without a visit, and home-screen apps are exempt.
          </p>
          <div className="offline-stat mono">
            {storage?.usageBytes != null
              ? `${fmtBytes(storage.usageBytes)} cached${
                  storage.quotaBytes ? ` of ${fmtBytes(storage.quotaBytes)} available` : ''
                }`
              : 'Storage use unavailable'}
            {storage?.persisted ? ' · protected from eviction' : ''}
          </div>
          <div className="btn-row">
            {!storage?.persisted && (
              <button
                onClick={() =>
                  void requestPersistence().then(() => storageInfo().then(setStorage))
                }
              >
                Keep offline data
              </button>
            )}
            <button
              onClick={() => {
                void (async () => {
                  await clearCachedTerrain()
                  await clearSession()
                  setStorage(await storageInfo())
                })()
              }}
            >
              Clear cache
            </button>
          </div>
        </section>

        <section>
          <h2>Project Data</h2>
          <div className="btn-row">
            <button disabled={!meta} onClick={exportProject}>
              Export
            </button>
            <button onClick={() => projectInput.current?.click()}>Import</button>
          </div>
          <h3>Offline Map Export</h3>
          <div className="btn-row">
            <button disabled={!meta} onClick={openExportDialog}>
              Export HTML/EPUB
            </button>
            <button disabled={!meta} onClick={() => void exportUsdzFile()}>
              Export USDZ
            </button>
          </div>
        </section>

        <footer className="credits mono">
          Elevation USGS 3DEP · Topo and NAIP USGS · Search Photon/OSM · Peak index USGS GNIS
        </footer>
      </aside>

      <main className="stage">
        <canvas ref={canvasRef} />
        <button
          className="compass"
          title="Face north"
          aria-label="Face north"
          onClick={() => viewerRef.current?.faceNorth()}
        >
          <div className="rose" ref={roseRef}>
            <svg viewBox="0 0 44 44" aria-hidden="true">
              <circle cx="22" cy="22" r="20" fill="none" stroke="#cdc3ac" strokeWidth="1" />
              {/* E / S / W ticks; north gets the letter */}
              <line x1="37" y1="22" x2="41" y2="22" stroke="#6b5f4d" strokeWidth="1.5" />
              <line x1="22" y1="37" x2="22" y2="41" stroke="#6b5f4d" strokeWidth="1.5" />
              <line x1="3" y1="22" x2="7" y2="22" stroke="#6b5f4d" strokeWidth="1.5" />
              <text
                x="22"
                y="13"
                textAnchor="middle"
                fontSize="12"
                fontFamily="Barlow Semi Condensed, sans-serif"
                fontWeight="700"
                fill="#2a2118"
              >
                N
              </text>
              <polygon
                points="22,15 17,23 27,23"
                fill="#7a4a21"
                stroke="#2a2118"
                strokeWidth="1"
              />
              <polygon
                points="17,23 27,23 22,31"
                fill="#f6f2e8"
                stroke="#2a2118"
                strokeWidth="1"
              />
            </svg>
          </div>
        </button>
        <div className="hud mono">{hint}</div>
        {busy && (
          <div className="busy" role="status">
            <div className="spinner" />
            <div>{busy}</div>
          </div>
        )}
        {error && (
          <button className="toast" onClick={() => setError(null)}>
            {error}
          </button>
        )}

        {selected && (
          <div className="inspector">
            {selected.kind === 'photo' && (
              <>
                <img
                  src={selected.dataUrl}
                  alt={selected.name}
                  className="ins-photo"
                  title="Click to enlarge"
                  onClick={() => setLightbox(selected.dataUrl)}
                />
                <div className="ins-name">{selected.name}</div>
                {selected.lon != null && selected.lat != null ? (
                  <div className="mono ins-line">
                    {formatDMS(selected.lat, selected.lon)}
                    {elevOf(selected.lon, selected.lat) != null &&
                      ` · ${fmtElev(elevOf(selected.lon, selected.lat)!, units)}`}
                  </div>
                ) : (
                  <div className="ins-line">Not placed yet</div>
                )}
                <div className="btn-row">
                  <button onClick={() => setMode({ type: selected.lon == null ? 'place-photo' : 'move', id: selected.id })}>
                    {selected.lon == null ? 'Place on terrain' : 'Move'}
                  </button>
                  {selected.lon != null && (
                    <label className="marker-size" title="Adjust marker size">
                      <span>Size</span>
                      <input
                        type="range"
                        min={0.1}
                        max={2}
                        step={0.05}
                        value={selected.scale ?? 1}
                        onChange={(e) =>
                          updateOverlay(selected.id, { scale: parseFloat(e.target.value) })
                        }
                        aria-label="Marker size"
                      />
                    </label>
                  )}
                </div>
              </>
            )}
            {selected.kind === 'note' && (
              <>
                <input
                  className="ins-title"
                  value={selected.name}
                  onChange={(e) => updateOverlay(selected.id, { name: e.target.value })}
                />
                <textarea
                  placeholder="Trip report, conditions, beta..."
                  value={selected.body}
                  onChange={(e) => updateOverlay(selected.id, { body: e.target.value })}
                  rows={5}
                />
                <div className="mono ins-line">
                  {formatDMS(selected.lat, selected.lon)}
                  {elevOf(selected.lon, selected.lat) != null &&
                    ` · ${fmtElev(elevOf(selected.lon, selected.lat)!, units)}`}
                </div>
                <div className="btn-row">
                  <button onClick={() => setMode({ type: 'move', id: selected.id })}>Move</button>
                  <label className="marker-size" title="Adjust marker size">
                    <span>Size</span>
                    <input
                      type="range"
                      min={0.1}
                      max={2}
                      step={0.05}
                      value={selected.scale ?? 1}
                      onChange={(e) =>
                        updateOverlay(selected.id, { scale: parseFloat(e.target.value) })
                      }
                      aria-label="Marker size"
                    />
                  </label>
                </div>
              </>
            )}
            {selected.kind === 'track' && (
              <>
                <div className="ins-name">{selected.name}</div>
                <div className="mono ins-line">
                  {fmtDistKm(trackLengthKm(selected.segments), units)} ·{' '}
                  {selected.segments.reduce((n, s) => n + s.length, 0)} points
                </div>
                <label className="field">
                  <span>Color</span>
                  <input
                    type="color"
                    value={selected.color}
                    onChange={(e) => updateOverlay(selected.id, { color: e.target.value })}
                  />
                </label>
              </>
            )}
          </div>
        )}
      </main>

      {lightbox && (
        <div
          className="lightbox"
          role="dialog"
          aria-label="Photo at full size"
          onClick={() => setLightbox(null)}
        >
          <img src={lightbox} alt="" />
        </div>
      )}

      {exportDialog && meta && (
        <div
          className="export-scrim"
          role="dialog"
          aria-label="Export web page"
          onClick={() => setExportDialog(false)}
        >
          <div className="export-dialog" onClick={(e) => e.stopPropagation()}>
            <h2>Export web page</h2>
            <div className="export-caption">
              One self-contained file - works offline, share it anywhere.
            </div>
            <span className="export-label">Format</span>
            <label className="export-check">
              <input
                type="radio"
                name="export-format"
                checked={exportFormat === 'web'}
                onChange={() => setExportFormat('web')}
              />
              Web page (.html) - any browser
            </label>
            <label className="export-check">
              <input
                type="radio"
                name="export-format"
                checked={exportFormat === 'epub'}
                onChange={() => setExportFormat('epub')}
              />
              Apple Books (.epub) - opens on iPhone/iPad
            </label>
            <span className="export-label">Layers</span>
            <div className="export-muted">Shaded relief is always included.</div>
            {(
              [
                ['topo', 'USGS topo'],
                ['imagery', 'Satellite (NAIP)'],
              ] as [string, string][]
            )
              .concat(customLayers.map((c) => [`custom:${c.id}`, c.name]))
              .map(([value, label]) => (
                <label key={value} className="export-check">
                  <input
                    type="checkbox"
                    checked={exportLayerIds.includes(value)}
                    onChange={() => toggleExportLayer(value)}
                  />
                  {label}
                </label>
              ))}
            <span className="export-label">Quality</span>
            <label className="export-check">
              <input
                type="radio"
                name="export-quality"
                checked={exportQuality === 'phone'}
                onChange={() => setExportQuality('phone')}
              />
              Phone-friendly (1024 grid)
            </label>
            {meta.width > 1024 && (
              <>
                <label className="export-check">
                  <input
                    type="radio"
                    name="export-quality"
                    checked={exportQuality === 'full'}
                    onChange={() => setExportQuality('full')}
                  />
                  Full detail ({meta.width} grid)
                </label>
                <div className="export-muted">Larger file, may strain phones.</div>
              </>
            )}
            <div className="mono export-muted">~{exportEstMb.toFixed(1)} MB</div>
            <div className="btn-row">
              <button className="primary" onClick={() => void exportPage()}>
                Export
              </button>
              <button onClick={() => setExportDialog(false)}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      <input
        ref={trackInput}
        type="file"
        accept=".gpx,.kml,.kmz"
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files) void addTrackFiles(e.target.files)
          e.target.value = ''
        }}
      />
      <input
        ref={photoInput}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files) void addPhotoFiles(e.target.files)
          e.target.value = ''
        }}
      />
      <input
        ref={tiffInput}
        type="file"
        accept=".tif,.tiff"
        hidden
        onChange={(e) => {
          if (e.target.files?.[0]) void addGeoTiff(e.target.files[0])
          e.target.value = ''
        }}
      />
      <input
        ref={projectInput}
        type="file"
        accept=".json"
        hidden
        onChange={(e) => {
          if (e.target.files?.[0]) void importProject(e.target.files[0])
          e.target.value = ''
        }}
      />
    </div>
  )
}

/** Live elevation ramp for the loaded DEM: the sheet legend. */
function HypsoStrip({ min, max, units }: { min: number; max: number; units: Units }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const dpr = window.devicePixelRatio || 1
    const w = canvas.clientWidth * dpr
    const h = canvas.clientHeight * dpr
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')!
    const grad = ctx.createLinearGradient(0, 0, w, 0)
    grad.addColorStop(0, '#4A7A52')
    grad.addColorStop(0.35, '#97A567')
    grad.addColorStop(0.6, '#C8B78A')
    grad.addColorStop(0.82, '#9C7B52')
    grad.addColorStop(1, '#EDEAE2')
    ctx.fillStyle = grad
    ctx.fillRect(0, 0, w, h)
    // Ticks in the display unit: every 500 m, or every 1000 ft
    ctx.strokeStyle = 'rgba(42,33,24,0.55)'
    ctx.lineWidth = dpr
    const lo = elevDisplay(min, units)
    const hi = elevDisplay(max, units)
    const step = elevTickStep(units)
    const range = Math.max(hi - lo, 1)
    for (let e = Math.ceil(lo / step) * step; e < hi; e += step) {
      const x = ((e - lo) / range) * w
      ctx.beginPath()
      ctx.moveTo(x, 0)
      ctx.lineTo(x, h * 0.45)
      ctx.stroke()
    }
    ctx.strokeStyle = 'rgba(42,33,24,0.9)'
    ctx.strokeRect(0.5 * dpr, 0.5 * dpr, w - dpr, h - dpr)
  }, [min, max, units])
  return (
    <div className="hypso">
      <canvas ref={ref} />
      <div className="hypso-labels mono">
        <span>{fmtElev(min, units)}</span>
        <span>{fmtElev(max, units)}</span>
      </div>
    </div>
  )
}
