import raw from './data/colorado-peaks.json'

/** Compact bundled peak index: USGS GNIS summit names/coordinates with
 *  elevations sampled from 3DEP (all public domain). Regenerate with
 *  backend/scripts/gnis_to_peaks_json.py. */
export interface Peak {
  /** Official GNIS name */
  n: string
  lat: number
  lon: number
  /** Elevation in meters */
  e: number
}

export type PeakClass = '14' | '13'

const FT = 0.3048

/** Sorted by elevation descending (the dataset ships pre-sorted). */
export const COLORADO_PEAKS = raw as Peak[]

export function peaksOf(cls: PeakClass): Peak[] {
  return COLORADO_PEAKS.filter((p) => {
    const ft = p.e / FT
    return cls === '14' ? ft >= 14000 : ft >= 13000 && ft < 14000
  })
}
