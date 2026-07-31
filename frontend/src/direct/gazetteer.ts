/**
 * The GNIS terrain gazetteer, searched in the browser.
 *
 * A port of backend/app/gazetteer.py. The index is the same gzipped TSV the
 * backend reads - it is a static asset, so nothing about searching it needs a
 * server. Moving it here removes the last routine reason for the app to call
 * a backend at all, and has the side benefit that search keeps working
 * offline once the file is cached.
 *
 * It is fetched lazily on the first query (about 2.9 MB gzipped, ~190k
 * features) and decompressed with DecompressionStream, which is native in
 * every browser this app targets.
 */

export interface GazetteerHit {
  name: string
  lat: number
  lon: number
  type: string
}

const CLASS_RANK: Record<string, number> = {
  Summit: 0, Range: 1, Gap: 2, Ridge: 3, Pillar: 4,
  Glacier: 5, Crater: 6, Arch: 7, Cliff: 8, Basin: 9,
  Valley: 10, Falls: 11, Slope: 12, Bench: 13, Flat: 14,
  Lava: 15, Isthmus: 16,
}

// Names GNIS files differently from what people search for. Kept tiny on
// purpose - this is not a synonym dictionary.
const ALIASES: Record<string, string> = {
  denali: 'mount mckinley',
}

interface Row {
  name: string
  lower: string
  cls: string
  state: string
  county: string
  lat: number
  lon: number
}

let rows: Row[] | null = null
let loading: Promise<Row[]> | null = null

export function isLoaded(): boolean {
  return rows !== null
}

async function load(url: string): Promise<Row[]> {
  if (rows) return rows
  if (loading) return loading
  loading = (async () => {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`Gazetteer fetch failed (${res.status})`)

    // Hosts disagree about a .gz asset. Some (Vite's dev server, and most
    // static hosts) send Content-Encoding: gzip, so the browser has already
    // decompressed it by the time we see the body; others serve the bytes
    // verbatim. Sniffing the gzip magic number handles both without
    // depending on how a particular deploy is configured.
    const buf = await res.arrayBuffer()
    const head = new Uint8Array(buf.slice(0, 2))
    const stillGzipped = head[0] === 0x1f && head[1] === 0x8b
    const text = stillGzipped
      ? await new Response(
          new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip')),
        ).text()
      : new TextDecoder().decode(buf)

    const out: Row[] = []
    let start = 0
    while (start < text.length) {
      let end = text.indexOf('\n', start)
      if (end === -1) end = text.length
      const line = text.slice(start, end)
      start = end + 1
      if (!line) continue
      const p = line.split('\t')
      if (p.length !== 6) continue
      const lat = +p[4]
      const lon = +p[5]
      if (!isFinite(lat) || !isFinite(lon)) continue
      out.push({ name: p[0], lower: p[0].toLowerCase(), cls: p[1], state: p[2], county: p[3], lat, lon })
    }
    rows = out
    return out
  })()
  return loading
}

/** Lower is better; -1 means no match. Mirrors the Python scorer. */
function score(needle: string, hay: string): number {
  if (hay === needle) return 0
  if (hay.startsWith(needle)) return 1
  if (hay.includes(' ' + needle)) return 2
  if (hay.includes(needle)) return 3
  return -1
}

export async function search(q: string, url: string, limit = 8): Promise<GazetteerHit[]> {
  let needle = q.toLowerCase().split(/\s+/).filter(Boolean).join(' ')
  if (!needle) return []
  needle = ALIASES[needle] ?? needle
  const all = await load(url)

  // Group by name so the result list shows variety: GNIS has 200-plus Bald
  // Mountains, and ranking purely by score buries everything else.
  const groups = new Map<string, [number, number, number, Row][]>()
  for (const r of all) {
    const s = score(needle, r.lower)
    if (s < 0) continue
    const key = r.lower
    const entry: [number, number, number, Row] = [s, CLASS_RANK[r.cls] ?? 99, r.name.length, r]
    const g = groups.get(key)
    if (g) g.push(entry)
    else groups.set(key, [entry])
  }

  const cmp = (a: [number, number, number, Row], b: [number, number, number, Row]): number =>
    a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
  const ordered = [...groups.values()]
  for (const g of ordered) g.sort(cmp)
  ordered.sort((a, b) => cmp(a[0], b[0]))

  // Round-robin: every distinct name contributes its best hit before any name
  // contributes a second.
  const out: GazetteerHit[] = []
  const seen = new Set<string>()
  const deepest = ordered.reduce((m, g) => Math.max(m, g.length), 0)
  for (let depth = 0; depth < deepest; depth++) {
    for (const g of ordered) {
      if (depth >= g.length) continue
      const r = g[depth][3]
      const key = `${r.lower}|${r.lat.toFixed(2)}|${r.lon.toFixed(2)}`
      if (seen.has(key)) continue
      seen.add(key)
      const region = [r.county, r.state].filter(Boolean).join(', ')
      out.push({
        name: region ? `${r.name}, ${region}` : r.name,
        lat: r.lat,
        lon: r.lon,
        type: r.cls.toLowerCase(),
      })
      if (out.length >= limit) return out
    }
  }
  return out
}
