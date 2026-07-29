import type { AreaMeta, SearchResult } from './types'

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
  const resp = await fetch('/api/area', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  })
  return jsonOrThrow(resp)
}

export async function fetchHeights(areaId: string): Promise<Float32Array> {
  const resp = await fetch(`/api/area/${areaId}/heights`)
  if (!resp.ok) throw new Error(`Heightmap fetch failed (${resp.status})`)
  return new Float32Array(await resp.arrayBuffer())
}

export function textureUrl(areaId: string, layer: 'topo' | 'imagery', size = 2048): string {
  return `/api/area/${areaId}/texture/${layer}?size=${size}`
}

export async function uploadGeoTiff(
  areaId: string,
  file: File,
): Promise<{ layer_id: string; name: string; url: string }> {
  const form = new FormData()
  form.append('file', file)
  const resp = await fetch(`/api/area/${areaId}/layers`, { method: 'POST', body: form })
  return jsonOrThrow(resp)
}

export async function search(q: string): Promise<SearchResult[]> {
  const resp = await fetch(`/api/search?q=${encodeURIComponent(q)}`)
  return jsonOrThrow(resp)
}
