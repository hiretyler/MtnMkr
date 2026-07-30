import type { AreaMeta, Overlay } from '../types'

/** id of the inline <script type="application/json"> block in the exported html */
export const PAYLOAD_SCRIPT_ID = 'mtnmkr-data'

export interface PayloadLayer {
  id: string
  name: string
  kind: 'shaded' | 'texture'
  dataUrl?: string
}

export interface StandalonePayload {
  version: 1
  /** ISO timestamp */
  generated: string
  units: 'metric' | 'imperial'
  /** post-downsample */
  area: AreaMeta
  center: { lat: number; lon: number; name: string | null }
  heights: {
    encoding: 'q16.gz.b64' | 'q16.b64'
    min: number
    max: number
    width: number
    height: number
    data: string
  }
  layers: PayloadLayer[]
  initialLayer: string
  exaggeration: number
  overlays: Overlay[]
  attribution: string
}
