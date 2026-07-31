import type { AreaMeta, Capabilities, SearchResult } from './types'

/**
 * Where the backend lives. Empty (the default) means same-origin, which is
 * what the Vite dev proxy gives you. Set VITE_API_BASE at build time when the
 * frontend is hosted apart from the API - e.g. a static deploy on shared
 * hosting with the FastAPI service somewhere that can actually run ASGI.
 * No trailing slash.
 */
export const API_BASE: string = (import.meta.env.VITE_API_BASE ?? '').replace(/\/$/, '')

export function apiUrl(path: string): string {
  return `${API_BASE}${path}`
}

async function jsonOrThrow(resp: Response) {
  if (!resp.ok) {
    let detail = `${resp.status} ${resp.statusText}`
    try {
      const body = await resp.json()
      if (body.detail) detail = String(body.detail)
    } catch {
      /* keep status text */
    }
    throw new Error(detail)
  }
  return resp.json()
}

export async function createArea(req: {
  lat: number
  lon: number
  radius_km: number
  size: number
  name?: string | null
}): Promise<AreaMeta> {
  const resp = await fetch(apiUrl('/api/area'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  })
  return jsonOrThrow(resp)
}

export async function fetchHeights(areaId: string): Promise<Float32Array> {
  const resp = await fetch(apiUrl(`/api/area/${areaId}/heights`))
  if (!resp.ok) throw new Error(`Heightmap fetch failed (${resp.status})`)
  return new Float32Array(await resp.arrayBuffer())
}

export function textureUrl(areaId: string, layer: 'topo' | 'imagery', size = 2048): string {
  return apiUrl(`/api/area/${areaId}/texture/${layer}?size=${size}`)
}

export async function uploadGeoTiff(
  areaId: string,
  file: File,
): Promise<{ layer_id: string; name: string; url: string }> {
  const form = new FormData()
  form.append('file', file)
  const resp = await fetch(apiUrl(`/api/area/${areaId}/layers`), { method: 'POST', body: form })
  const out = await jsonOrThrow(resp)
  // The backend returns a root-relative url; make it absolute against the
  // API origin so it still resolves when the frontend is hosted separately.
  return { ...out, url: apiUrl(out.url) }
}

export async function search(q: string, worldwide = false): Promise<SearchResult[]> {
  const resp = await fetch(
    apiUrl(`/api/search?q=${encodeURIComponent(q)}${worldwide ? '&worldwide=true' : ''}`),
  )
  return jsonOrThrow(resp)
}

/** What this build supports. A packaged binary may ship without GDAL, so the
 *  UI feature-detects rather than offering controls that fail server-side. */
export async function fetchCapabilities(): Promise<Capabilities> {
  const resp = await fetch(apiUrl('/api/capabilities'))
  if (!resp.ok) throw new Error(`Capabilities fetch failed (${resp.status})`)
  return resp.json()
}
