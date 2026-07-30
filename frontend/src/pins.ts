import * as THREE from 'three'

/**
 * Canvas-drawn map pins in the survey-marker idiom: a circular head on a
 * tapered stem, ink outline. Photo pins get the photo itself clipped into
 * the head, like a print pinned to a quad sheet.
 */

const W = 128
const H = 168
const CX = W / 2
const HEAD_R = 46
const HEAD_CY = 54

function pinPath(ctx: CanvasRenderingContext2D) {
  ctx.beginPath()
  // Head circle with a tapered tail down to the tip
  ctx.arc(CX, HEAD_CY, HEAD_R, Math.PI * 0.78, Math.PI * 0.22, false)
  ctx.lineTo(CX, H - 4)
  ctx.closePath()
}

function drawBase(ctx: CanvasRenderingContext2D, fill: string, ink: string) {
  pinPath(ctx)
  ctx.fillStyle = fill
  ctx.fill()
  ctx.lineWidth = 5
  ctx.strokeStyle = ink
  ctx.stroke()
}

export function makeNotePinTexture(color = '#33638A'): THREE.CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')!
  drawBase(ctx, color, '#2A2118')
  // Benchmark-style cross in the head
  ctx.strokeStyle = '#EDE8DC'
  ctx.lineWidth = 7
  ctx.lineCap = 'round'
  const r = 20
  ctx.beginPath()
  ctx.moveTo(CX - r, HEAD_CY)
  ctx.lineTo(CX + r, HEAD_CY)
  ctx.moveTo(CX, HEAD_CY - r)
  ctx.lineTo(CX, HEAD_CY + r)
  ctx.stroke()
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

export function makePhotoPinTexture(
  dataUrl: string,
  onReady: (tex: THREE.CanvasTexture) => void,
): THREE.CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')!
  drawBase(ctx, '#7A4A21', '#2A2118')
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace

  const img = new Image()
  img.onload = () => {
    drawBase(ctx, '#7A4A21', '#2A2118')
    ctx.save()
    ctx.beginPath()
    ctx.arc(CX, HEAD_CY, HEAD_R - 7, 0, Math.PI * 2)
    ctx.clip()
    const s = Math.max((2 * (HEAD_R - 7)) / img.width, (2 * (HEAD_R - 7)) / img.height)
    const dw = img.width * s
    const dh = img.height * s
    ctx.drawImage(img, CX - dw / 2, HEAD_CY - dh / 2, dw, dh)
    ctx.restore()
    ctx.beginPath()
    ctx.arc(CX, HEAD_CY, HEAD_R - 7, 0, Math.PI * 2)
    ctx.lineWidth = 4
    ctx.strokeStyle = '#EDE8DC'
    ctx.stroke()
    tex.needsUpdate = true
    onReady(tex)
  }
  img.src = dataUrl
  return tex
}

export const PIN_ASPECT = W / H

/**
 * Summit benchmark: USGS-style ink triangle at the high point with a chip
 * above it - peak name (when known) over elevation. 384x160 canvas,
 * anchor at bottom center.
 */
const SW = 384
const SH = 160
export const SUMMIT_ASPECT = SW / SH

function ellipsize(ctx: CanvasRenderingContext2D, text: string, maxW: number): string {
  if (ctx.measureText(text).width <= maxW) return text
  let t = text
  while (t.length > 1 && ctx.measureText(`${t}…`).width > maxW) {
    t = t.slice(0, -1)
  }
  return `${t}…`
}

export function makeSummitTexture(elevLabel: string, name?: string | null): THREE.CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = SW
  canvas.height = SH
  const ctx = canvas.getContext('2d')!
  const cx = SW / 2

  // Triangle sitting on the anchor point
  ctx.beginPath()
  ctx.moveTo(cx, SH - 30)
  ctx.lineTo(cx - 15, SH - 4)
  ctx.lineTo(cx + 15, SH - 4)
  ctx.closePath()
  ctx.fillStyle = '#2A2118'
  ctx.strokeStyle = '#F6F2E8'
  ctx.lineWidth = 5
  ctx.stroke()
  ctx.fill()

  const nameFont = '600 30px "Barlow Semi Condensed", sans-serif'
  const elevFont = '500 26px "IBM Plex Mono", monospace'
  const displayName = name ? name.toUpperCase() : null

  ctx.font = elevFont
  let textW = ctx.measureText(elevLabel).width
  if (displayName) {
    ctx.font = nameFont
    textW = Math.max(textW, Math.min(ctx.measureText(displayName).width, SW - 50))
  }
  const chipW = Math.min(textW + 34, SW - 8)
  const chipH = displayName ? 84 : 48
  const chipY = SH - 34 - chipH

  ctx.fillStyle = 'rgba(246, 242, 232, 0.95)'
  ctx.strokeStyle = '#2A2118'
  ctx.lineWidth = 3
  ctx.fillRect(cx - chipW / 2, chipY, chipW, chipH)
  ctx.strokeRect(cx - chipW / 2, chipY, chipW, chipH)

  ctx.fillStyle = '#2A2118'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  if (displayName) {
    ctx.font = nameFont
    ctx.fillText(ellipsize(ctx, displayName, chipW - 20), cx, chipY + 24)
    ctx.font = elevFont
    ctx.fillStyle = '#6B5F4D'
    ctx.fillText(elevLabel, cx, chipY + 60)
  } else {
    ctx.font = elevFont
    ctx.fillText(elevLabel, cx, chipY + chipH / 2)
  }

  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}
