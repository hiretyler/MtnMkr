export type Units = 'metric' | 'imperial'

const KM_PER_MI = 1.609344
const M_PER_FT = 0.3048

export function fmtDistKm(km: number, units: Units): string {
  return units === 'metric'
    ? `${km.toFixed(1)} km`
    : `${(km / KM_PER_MI).toFixed(1)} mi`
}

export function fmtElev(m: number, units: Units): string {
  return units === 'metric'
    ? `${Math.round(m).toLocaleString()} m`
    : `${Math.round(m / M_PER_FT).toLocaleString()} ft`
}

export function fmtRes(mPerPx: number, units: Units): string {
  return units === 'metric'
    ? `${mPerPx.toFixed(1)} m/px`
    : `${(mPerPx / M_PER_FT).toFixed(1)} ft/px`
}

export function elevDisplay(m: number, units: Units): number {
  return units === 'metric' ? m : m / M_PER_FT
}

/** Sensible legend tick spacing in the display unit. */
export function elevTickStep(units: Units): number {
  return units === 'metric' ? 500 : 1000
}

// Contour intervals on offer. The choice is stored in meters whichever unit
// system is showing, so a units switch only re-labels it - snapped to the
// nearest interval the new system offers, which keeps the select's label and
// the lines on the mountain describing the same spacing.
const CONTOUR_M = [10, 25, 50, 100]
const CONTOUR_FT = [40, 80, 200, 500]

export const CONTOUR_METERS = [...CONTOUR_M, ...CONTOUR_FT.map((ft) => ft * M_PER_FT)]

export function contourChoices(units: Units): { meters: number; label: string }[] {
  return units === 'metric'
    ? CONTOUR_M.map((m) => ({ meters: m, label: `${m} m` }))
    : CONTOUR_FT.map((ft) => ({ meters: ft * M_PER_FT, label: `${ft} ft` }))
}

export function nearestContour(meters: number, units: Units): number {
  const choices = contourChoices(units)
  let best = choices[0].meters
  for (const c of choices) {
    if (Math.abs(c.meters - meters) < Math.abs(best - meters)) best = c.meters
  }
  return best
}
