import { useCallback, useEffect, useRef, useState } from 'react'
import * as api from './api'
import { formatDMS, trackLengthKm } from './geo'
import { parseGpx, parseKml, parseKmz, photoFromFile } from './parsers'
import { elevDisplay, elevTickStep, fmtDistKm, fmtElev, fmtRes, type Units } from './units'
import type {
  AreaMeta,
  BaseLayer,
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

  const [q, setQ] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [searching, setSearching] = useState(false)
  const [searched, setSearched] = useState(false)
  const [units, setUnits] = useState<Units>(() =>
    localStorage.getItem('mtnmkr-units') === 'imperial' ? 'imperial' : 'metric',
  )
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

  const showError = useCallback((e: unknown) => {
    setError(e instanceof Error ? e.message : String(e))
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
    } else if (layer === 'topo' || layer === 'imagery') {
      viewer.setTextureUrl(api.textureUrl(meta.id, layer)).catch(showError)
    } else {
      const id = layer.slice('custom:'.length)
      const cl = customLayers.find((c) => c.id === id)
      if (cl) viewer.setTextureUrl(cl.url).catch(showError)
    }
  }, [layer, meta, customLayers, showError])

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
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    localStorage.setItem('mtnmkr-units', units)
  }, [units])

  // Summit benchmark: label the DEM high point, in the current units
  useEffect(() => {
    if (meta) viewerRef.current?.setSummitLabel(fmtElev(meta.max_elev, units))
  }, [meta, units])

  // Close the search dropdown on any press outside it
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (searchWrapRef.current && !searchWrapRef.current.contains(e.target as Node)) {
        setResults([])
        setSearched(false)
      }
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [])

  // ---- terrain loading --------------------------------------------------

  const loadAreaAt = useCallback(
    async (lat: number, lon: number, name: string | null, r?: number, s?: number) => {
      const radius = r ?? radiusKm
      const px = s ?? size
      setCenter({ lat, lon, name })
      setBusy('Requesting elevation from USGS 3DEP (first load can take a minute)...')
      try {
        const m = await api.createArea({ lat, lon, radius_km: radius, size: px, name })
        setBusy('Downloading heightmap...')
        const heights = await api.fetchHeights(m.id)
        viewerRef.current?.setTerrain(m, heights)
        setMeta(m)
        setCustomLayers([])
        if (layer.startsWith('custom:')) setLayer('shaded')
        location.hash = `lat=${lat.toFixed(5)}&lon=${lon.toFixed(5)}&r=${radius}&s=${px}${
          name ? `&name=${encodeURIComponent(name)}` : ''
        }`
      } catch (e) {
        showError(e)
      } finally {
        setBusy(null)
      }
    },
    [radiusKm, size, layer, showError],
  )

  const didInit = useRef(false)
  useEffect(() => {
    if (didInit.current) return
    didInit.current = true
    const p = new URLSearchParams(location.hash.slice(1))
    const lat = parseFloat(p.get('lat') ?? '')
    const lon = parseFloat(p.get('lon') ?? '')
    if (isFinite(lat) && isFinite(lon)) {
      const r = parseFloat(p.get('r') ?? '') || 4
      const s = parseInt(p.get('s') ?? '') || 1024
      setRadiusKm(r)
      setSize(s)
      void loadAreaAt(lat, lon, p.get('name'), r, s)
    }
  }, [loadAreaAt])

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
    setSearching(true)
    setResults([])
    setSearched(false)
    try {
      setResults(await api.search(query))
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
    let unplaced = 0
    for (const file of Array.from(files)) {
      try {
        const p = await photoFromFile(file)
        const photo: PhotoOverlay = {
          id: uid(),
          kind: 'photo',
          name: p.name,
          visible: true,
          lon: p.lon,
          lat: p.lat,
          dataUrl: p.dataUrl,
        }
        if (p.lon == null) unplaced++
        setOverlays((prev) => [...prev, photo])
      } catch (e) {
        showError(e)
      }
    }
    if (unplaced > 0) {
      setError(
        `${unplaced} photo${unplaced > 1 ? 's have' : ' has'} no GPS tag - select it in the data list and use "Place on terrain".`,
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

  // ---- derived ----------------------------------------------------------

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
          <div className="eyebrow">Provisional 3D edition</div>
          <h1>MtnMkr</h1>
          <div className="masthead-sub">Build a better mountain from lidar and your own trips</div>
        </header>

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
                placeholder='Peak name or "lat, lon"'
                aria-label="Search for a peak"
              />
              <button type="submit" disabled={searching}>
                {searching ? '...' : 'Find'}
              </button>
            </form>
            {(results.length > 0 || (searched && results.length === 0)) && (
              <ul className="results">
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
              onClick={() => void loadAreaAt(center.lat, center.lon, center.name)}
            >
              Rebuild terrain
            </button>
          )}
        </section>

        {meta && (
          <section className="sheet">
            <h2>Sheet</h2>
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
          <button disabled={!meta} onClick={() => tiffInput.current?.click()}>
            Add GeoTIFF layer
          </button>
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
              {overlays.map((o) => (
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
              ))}
            </ul>
          )}
        </section>

        <section>
          <h2>Project</h2>
          <div className="btn-row">
            <button disabled={!meta} onClick={exportProject}>
              Export
            </button>
            <button onClick={() => projectInput.current?.click()}>Import</button>
          </div>
        </section>

        <footer className="credits mono">
          Elevation USGS 3DEP · Topo and NAIP USGS · Search OSM Nominatim
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
                <img src={selected.dataUrl} alt={selected.name} />
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
