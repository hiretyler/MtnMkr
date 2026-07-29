import exifr from 'exifr'
import { unzipSync } from 'fflate'
import type { TrackPoint } from './types'

export interface ParsedTrack {
  name: string
  segments: TrackPoint[][]
}

export interface ParsedPoint {
  name: string
  body: string
  lon: number
  lat: number
}

export interface ParseResult {
  tracks: ParsedTrack[]
  points: ParsedPoint[]
}

function parseXml(text: string): Document {
  const doc = new DOMParser().parseFromString(text, 'application/xml')
  if (doc.getElementsByTagName('parsererror').length > 0) {
    throw new Error('File is not valid XML')
  }
  return doc
}

function byLocalName(root: Element | Document, name: string): Element[] {
  return Array.from(root.getElementsByTagName('*')).filter((e) => e.localName === name)
}

function childText(el: Element, name: string): string {
  for (const c of Array.from(el.children)) {
    if (c.localName === name) return c.textContent?.trim() ?? ''
  }
  return ''
}

export function parseGpx(text: string): ParseResult {
  const doc = parseXml(text)
  const tracks: ParsedTrack[] = []
  const points: ParsedPoint[] = []

  const readPt = (el: Element): TrackPoint | null => {
    const lat = parseFloat(el.getAttribute('lat') ?? '')
    const lon = parseFloat(el.getAttribute('lon') ?? '')
    if (!isFinite(lat) || !isFinite(lon)) return null
    const eleText = childText(el, 'ele')
    const ele = eleText ? parseFloat(eleText) : NaN
    return [lon, lat, isFinite(ele) ? ele : null]
  }

  for (const trk of byLocalName(doc, 'trk')) {
    const segments: TrackPoint[][] = []
    for (const seg of byLocalName(trk, 'trkseg')) {
      const pts = byLocalName(seg, 'trkpt')
        .map(readPt)
        .filter((p): p is TrackPoint => p !== null)
      if (pts.length > 1) segments.push(pts)
    }
    if (segments.length > 0) {
      tracks.push({ name: childText(trk, 'name') || 'GPX track', segments })
    }
  }

  for (const rte of byLocalName(doc, 'rte')) {
    const pts = byLocalName(rte, 'rtept')
      .map(readPt)
      .filter((p): p is TrackPoint => p !== null)
    if (pts.length > 1) {
      tracks.push({ name: childText(rte, 'name') || 'GPX route', segments: [pts] })
    }
  }

  for (const wpt of byLocalName(doc, 'wpt')) {
    const p = readPt(wpt)
    if (!p) continue
    points.push({
      name: childText(wpt, 'name') || 'Waypoint',
      body: childText(wpt, 'desc') || childText(wpt, 'cmt'),
      lon: p[0],
      lat: p[1],
    })
  }

  return { tracks, points }
}

function parseCoordTriplets(text: string): TrackPoint[] {
  // KML coordinates: "lon,lat[,ele]" tuples separated by whitespace
  const pts: TrackPoint[] = []
  for (const tok of text.trim().split(/\s+/)) {
    const parts = tok.split(',')
    if (parts.length < 2) continue
    const lon = parseFloat(parts[0])
    const lat = parseFloat(parts[1])
    const ele = parts.length > 2 ? parseFloat(parts[2]) : NaN
    if (isFinite(lon) && isFinite(lat)) pts.push([lon, lat, isFinite(ele) ? ele : null])
  }
  return pts
}

export function parseKml(text: string): ParseResult {
  const doc = parseXml(text)
  const tracks: ParsedTrack[] = []
  const points: ParsedPoint[] = []

  for (const pm of byLocalName(doc, 'Placemark')) {
    const name = childText(pm, 'name') || 'KML feature'
    const desc = childText(pm, 'description')
    const segments: TrackPoint[][] = []

    for (const geom of byLocalName(pm, 'LineString').concat(byLocalName(pm, 'LinearRing'))) {
      const coordEl = byLocalName(geom, 'coordinates')[0]
      if (!coordEl) continue
      const pts = parseCoordTriplets(coordEl.textContent ?? '')
      if (pts.length > 1) segments.push(pts)
    }

    // Google Earth gx:Track: <gx:coord>lon lat ele</gx:coord>
    for (const gxTrack of byLocalName(pm, 'Track')) {
      const pts: TrackPoint[] = []
      for (const coord of byLocalName(gxTrack, 'coord')) {
        const parts = (coord.textContent ?? '').trim().split(/\s+/)
        if (parts.length < 2) continue
        const lon = parseFloat(parts[0])
        const lat = parseFloat(parts[1])
        const ele = parts.length > 2 ? parseFloat(parts[2]) : NaN
        if (isFinite(lon) && isFinite(lat)) pts.push([lon, lat, isFinite(ele) ? ele : null])
      }
      if (pts.length > 1) segments.push(pts)
    }

    if (segments.length > 0) {
      tracks.push({ name, segments })
    }

    for (const pt of byLocalName(pm, 'Point')) {
      const coordEl = byLocalName(pt, 'coordinates')[0]
      if (!coordEl) continue
      const pts = parseCoordTriplets(coordEl.textContent ?? '')
      if (pts.length > 0) {
        points.push({ name, body: desc, lon: pts[0][0], lat: pts[0][1] })
      }
    }
  }

  return { tracks, points }
}

export function parseKmz(buf: ArrayBuffer): ParseResult {
  const files = unzipSync(new Uint8Array(buf))
  const kmlName =
    Object.keys(files).find((n) => n.toLowerCase() === 'doc.kml') ??
    Object.keys(files).find((n) => n.toLowerCase().endsWith('.kml'))
  if (!kmlName) throw new Error('KMZ contains no KML document')
  return parseKml(new TextDecoder().decode(files[kmlName]))
}

/** Downscale to a storable data URL (kept under ~2000 px so project export stays sane). */
async function toDataUrl(file: File, maxDim = 1800): Promise<string> {
  const url = URL.createObjectURL(file)
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image()
      el.onload = () => resolve(el)
      el.onerror = () => reject(new Error(`Could not decode image ${file.name}`))
      el.src = url
    })
    const scale = Math.min(1, maxDim / Math.max(img.width, img.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(img.width * scale)
    canvas.height = Math.round(img.height * scale)
    canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height)
    return canvas.toDataURL('image/jpeg', 0.85)
  } finally {
    URL.revokeObjectURL(url)
  }
}

export interface ParsedPhoto {
  name: string
  lon: number | null
  lat: number | null
  dataUrl: string
}

export async function photoFromFile(file: File): Promise<ParsedPhoto> {
  let lon: number | null = null
  let lat: number | null = null
  try {
    const gps = await exifr.gps(file)
    if (gps && isFinite(gps.latitude) && isFinite(gps.longitude)) {
      lat = gps.latitude
      lon = gps.longitude
    }
  } catch {
    /* no EXIF GPS - user will place it by hand */
  }
  const dataUrl = await toDataUrl(file)
  return { name: file.name, lon, lat, dataUrl }
}
