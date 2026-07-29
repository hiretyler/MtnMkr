import raw from './data/colorado-peaks.json'

/** Compact bundled peak index (source: 14ers.com waypoint export). */
export interface Peak {
  /** Name; 14ers.com wraps unofficial/unranked names in quotes */
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
