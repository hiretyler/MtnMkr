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
