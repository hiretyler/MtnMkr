export interface AreaMeta {
  id: string
  name: string | null
  lat: number
  lon: number
  radius_km: number
  size: number
  width: number
  height: number
  bbox3857: [number, number, number, number]
  cos_lat: number
  ground_size_m: number
  resolution_m: number
  dem_source: 'usgs-3dep' | 'terrarium'
  min_elev: number
  max_elev: number
}

/** [lon, lat, ele | null] */
export type TrackPoint = [number, number, number | null]

export interface TrackOverlay {
  id: string
  kind: 'track'
  name: string
  color: string
  visible: boolean
  segments: TrackPoint[][]
  /** Importing file name; overlays sharing a source group together */
  source?: string
}

export interface PhotoOverlay {
  id: string
  kind: 'photo'
  name: string
  visible: boolean
  /** null until the user places it (no EXIF GPS) */
  lon: number | null
  lat: number | null
  dataUrl: string
  source?: string
  /** Marker size multiplier (default 1) */
  scale?: number
}

export interface NoteOverlay {
  id: string
  kind: 'note'
  name: string
  visible: boolean
  lon: number
  lat: number
  body: string
  source?: string
  /** Marker size multiplier (default 1) */
  scale?: number
  /** Pin fill; defaults to the standard note blue. Used to set the
   *  "my position" marker apart from trip notes. */
  color?: string
}

export type Overlay = TrackOverlay | PhotoOverlay | NoteOverlay

export interface CustomLayer {
  id: string
  name: string
  url: string
}

export type BaseLayer = 'shaded' | 'topo' | 'imagery' | `custom:${string}`

export interface ProjectFile {
  version: 1
  area: {
    lat: number
    lon: number
    radius_km: number
    size: number
    name: string | null
  }
  layer: BaseLayer
  exaggeration: number
  overlays: Overlay[]
}

export interface SearchResult {
  name: string
  lat: number
  lon: number
  type: string
}

/** Reported by /api/capabilities. A packaged build may omit GDAL or the
 *  bundled gazetteer, so controls that depend on them are feature-detected. */
export interface Capabilities {
  /** rasterio/GDAL present, so custom GeoTIFF layers can be warped */
  geotiff: boolean
  /** the bundled US GNIS index shipped with this build */
  gazetteer: boolean
  /** the Photon proxy is reachable for opt-in worldwide search */
  worldwide_search: boolean
}
