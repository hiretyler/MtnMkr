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
 * Summit benchmark: USGS-style ink triangle at the high point with an
 * elevation chip above it. 256x128 canvas, anchor at bottom center.
 */
export function makeSummitTexture(label: string): THREE.CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = 256
  canvas.height = 128
  const ctx = canvas.getContext('2d')!
  const cx = 128

  // Triangle sitting on the anchor point
  ctx.beginPath()
  ctx.moveTo(cx, 98)
  ctx.lineTo(cx - 15, 124)
  ctx.lineTo(cx + 15, 124)
  ctx.closePath()
  ctx.fillStyle = '#2A2118'
  ctx.strokeStyle = '#F6F2E8'
  ctx.lineWidth = 5
  ctx.stroke()
  ctx.fill()

  // Elevation chip
  ctx.font = '600 30px "Barlow Semi Condensed", sans-serif'
  const tw = ctx.measureText(label).width
  const chipW = Math.min(tw + 34, 250)
  ctx.fillStyle = 'rgba(246, 242, 232, 0.95)'
  ctx.strokeStyle = '#2A2118'
  ctx.lineWidth = 3
  ctx.fillRect(cx - chipW / 2, 40, chipW, 46)
  ctx.strokeRect(cx - chipW / 2, 40, chipW, 46)
  ctx.fillStyle = '#2A2118'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(label, cx, 64)

  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}
