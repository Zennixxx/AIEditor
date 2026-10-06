// Отрисовка таймлайна в Canvas 2D. Чистая функция от состояния: draw(ctx, scene).
import { EPS, itemEnd, sourceAtTimeline } from '@/model/clipTime'
import { clipKeyTimes } from '@/model/clipKeys'
import { clipAnimatable, evaluateAnimatable, isAnimated, LANE_FIELDS, type LaneProp } from '@/model/keyframes'
import { isClip } from '@/model/lookup'
import { getEffectDef } from '@/shared/effects-registry'
import type { Asset, Clip, Ease, Project, Thumbs, TrackItem, Waveform } from '@/shared/types.gen'
import { SECTION_COLORS } from '@/model/markers'
import type { TimelineSection } from '@/model/sections'
import {
  LANE_H,
  laneScreenTop,
  RULER_H,
  SECTION_H,
  rowScreenTop,
  timeToX,
  xToTime,
  type TrackRow,
  type View,
} from './geometry'
import type { KeyView } from './keyLayout'
import type { MarkerView } from './markerLayout'
import { rulerTicks } from './ruler'

export interface Palette {
  bg: string
  rowA: string
  rowB: string
  ruler: string
  rulerText: string
  tick: string
  border: string
  text: string
  textDim: string
  accent: string
  playhead: string
  snap: string
  video: string
  audio: string
  fx: string
}

export const DEFAULT_PALETTE: Palette = {
  bg: '#121419',
  rowA: '#16181d',
  rowB: '#191c22',
  ruler: '#1c1f26',
  rulerText: '#9aa1b2',
  tick: '#3a3f4c',
  border: '#2a2e38',
  text: '#e6e8ee',
  textDim: '#9aa1b2',
  accent: '#8b6cff',
  playhead: '#ff4d5e',
  snap: '#ffd84d',
  video: '#3a5a9c',
  audio: '#2b7a5a',
  fx: '#7a4ca0',
}

/** Элемент, отрисовываемый «призраком» в новой позиции во время drag. */
export interface Ghost {
  item: TrackItem
  start: number
  trackId: string
  valid: boolean
}

export interface Overlay {
  ghosts: Ghost[]
  /** Призрак ассета, который тащат из Media Bin. */
  dropGhost: { start: number; duration: number; trackId: string | null; label: string } | null
  box: { x0: number; y0: number; x1: number; y1: number } | null
  snapAt: number | null
  bladeX: number | null
}

export function emptyOverlay(): Overlay {
  return { ghosts: [], dropGhost: null, box: null, snapAt: null, bladeX: null }
}

export interface MediaSource {
  thumbs: (asset: Asset) => Thumbs | null
  image: (url: string) => HTMLImageElement | null
  waveform: (asset: Asset) => Waveform | null
  tile: (t: Thumbs, src: number) => { sprite: string; sx: number; sy: number; sw: number; sh: number } | null
}

export interface Scene {
  project: Project
  rows: readonly TrackRow[]
  view: View
  assets: (id: string) => Asset | undefined
  selection: ReadonlySet<string>
  playhead: number
  overlay: Overlay
  solo: readonly string[]
  /** Видимые маркеры в экранных координатах (после фильтра и прореживания). */
  markers: readonly MarkerView[]
  /** Секции композиции и музыки в timeline time. */
  sections: readonly TimelineSection[]
  /** Ключевые кадры на дорожках свойств в экранных координатах. */
  keys: readonly KeyView[]
  media: MediaSource
  palette: Palette
  inPoint?: number | null
  outPoint?: number | null
}

const FONT = '11px "Inter Variable", Inter, system-ui, sans-serif'

export function drawTimeline(ctx: CanvasRenderingContext2D, s: Scene): void {
  const { view: v, palette: c } = s
  ctx.save()
  ctx.fillStyle = c.bg
  ctx.fillRect(0, 0, v.width, v.height)
  ctx.font = FONT
  ctx.textBaseline = 'middle'

  // дорожки
  ctx.save()
  ctx.beginPath()
  ctx.rect(0, RULER_H, v.width, v.height - RULER_H)
  ctx.clip()
  const t0 = xToTime(0, v)
  const t1 = xToTime(v.width, v)
  const moving = new Set(s.overlay.ghosts.map((g) => g.item.id))
  for (const row of s.rows) {
    const top = rowScreenTop(row, v)
    if (top > v.height || top + row.height < RULER_H) continue
    ctx.fillStyle = row.index % 2 ? c.rowB : c.rowA
    ctx.fillRect(0, top, v.width, row.height)
    ctx.fillStyle = c.border
    ctx.fillRect(0, top + row.height - 1, v.width, 1)
    const dim =
      row.track.hidden ||
      row.track.muted ||
      (s.solo.length > 0 && row.track.kind === 'audio' && !s.solo.includes(row.track.id))
    for (const item of row.track.items) {
      if (itemEnd(item) < t0 || item.start > t1) continue
      drawItem(ctx, s, item, item.start, top, row.itemHeight, {
        selected: s.selection.has(item.id),
        dim: dim || moving.has(item.id),
        ghost: false,
        locked: row.track.locked,
      })
    }
    if (row.lanes.length > 0) drawLanes(ctx, s, row, t0, t1)
  }
  drawKeys(ctx, s.keys, c)
  // призраки перемещения
  for (const g of s.overlay.ghosts) {
    const row = s.rows.find((r) => r.track.id === g.trackId)
    if (!row) continue
    drawItem(ctx, s, g.item, g.start, rowScreenTop(row, v), row.itemHeight, {
      selected: true,
      dim: false,
      ghost: true,
      invalid: !g.valid,
      locked: false,
    })
  }
  const dg = s.overlay.dropGhost
  if (dg) {
    const row = s.rows.find((r) => r.track.id === dg.trackId)
    const top = row
      ? rowScreenTop(row, v)
      : RULER_H +
        (s.rows.length ? s.rows[s.rows.length - 1]!.top + s.rows[s.rows.length - 1]!.height : 0) -
        v.scrollY
    const h = row ? row.itemHeight : 40
    const x0 = timeToX(dg.start, v)
    const w = dg.duration * v.pxPerSec
    ctx.fillStyle = 'rgba(139,108,255,0.25)'
    ctx.fillRect(x0, top + 2, w, h - 4)
    ctx.setLineDash([4, 3])
    ctx.strokeStyle = c.accent
    ctx.strokeRect(x0 + 0.5, top + 2.5, w - 1, h - 5)
    ctx.setLineDash([])
    ctx.fillStyle = c.text
    ctx.fillText(dg.label, x0 + 6, top + 12)
  }
  drawMarkerLines(ctx, s)
  ctx.restore()

  // рамка выделения
  const box = s.overlay.box
  if (box) {
    const x = Math.min(box.x0, box.x1)
    const y = Math.min(box.y0, box.y1)
    ctx.fillStyle = 'rgba(139,108,255,0.12)'
    ctx.fillRect(x, y, Math.abs(box.x1 - box.x0), Math.abs(box.y1 - box.y0))
    ctx.strokeStyle = c.accent
    ctx.strokeRect(x + 0.5, y + 0.5, Math.abs(box.x1 - box.x0), Math.abs(box.y1 - box.y0))
  }

  drawRuler(ctx, s)
  drawSections(ctx, s)
  drawRulerMarkers(ctx, s)

  // линия привязки — через весь таймлайн
  if (s.overlay.snapAt !== null) {
    const x = Math.round(timeToX(s.overlay.snapAt, v)) + 0.5
    ctx.strokeStyle = c.snap
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(x, 0)
    ctx.lineTo(x, v.height)
    ctx.stroke()
  }

  if (s.overlay.bladeX !== null) {
    const x = Math.round(s.overlay.bladeX) + 0.5
    ctx.strokeStyle = 'rgba(255,255,255,0.7)'
    ctx.setLineDash([3, 3])
    ctx.beginPath()
    ctx.moveTo(x, RULER_H)
    ctx.lineTo(x, v.height)
    ctx.stroke()
    ctx.setLineDash([])
  }

  // плейхед
  const px = Math.round(timeToX(s.playhead, v)) + 0.5
  if (px >= -8 && px <= v.width + 8) {
    ctx.strokeStyle = c.playhead
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(px, RULER_H - 6)
    ctx.lineTo(px, v.height)
    ctx.stroke()
    ctx.fillStyle = c.playhead
    ctx.beginPath()
    ctx.moveTo(px - 6, 4)
    ctx.lineTo(px + 6, 4)
    ctx.lineTo(px + 6, RULER_H - 10)
    ctx.lineTo(px, RULER_H - 4)
    ctx.lineTo(px - 6, RULER_H - 10)
    ctx.closePath()
    ctx.fill()
  }
  ctx.restore()
}

function drawRuler(ctx: CanvasRenderingContext2D, s: Scene): void {
  const { view: v, palette: c } = s
  ctx.fillStyle = c.ruler
  ctx.fillRect(0, 0, v.width, RULER_H)
  ctx.fillStyle = c.border
  ctx.fillRect(0, RULER_H - 1, v.width, 1)
  drawInOut(ctx, s)
  const ticks = rulerTicks(xToTime(0, v), xToTime(v.width, v), v.pxPerSec, s.project.fps)
  ctx.fillStyle = c.tick
  for (const tick of ticks) {
    const x = Math.round(timeToX(tick.t, v)) + 0.5
    ctx.fillRect(x - 0.5, tick.major ? RULER_H - 12 : RULER_H - 6, 1, tick.major ? 12 : 6)
  }
  ctx.fillStyle = c.rulerText
  ctx.font = '10px ui-monospace, Consolas, monospace'
  for (const tick of ticks) {
    if (tick.label) ctx.fillText(tick.label, Math.round(timeToX(tick.t, v)) + 4, SECTION_H + 10)
  }
  ctx.font = FONT
}

/** Полоса секций над линейкой: цветные плашки с подписью (секции композиции и музыки, в timeline time). */
function drawInOut(ctx: CanvasRenderingContext2D, s: Scene): void {
  const inP = s.inPoint ?? null
  const outP = s.outPoint ?? null
  if (inP === null && outP === null) return
  const { view: v, palette: c } = s
  const x0 = inP === null ? timeToX(0, v) : timeToX(inP, v)
  const x1 = outP === null ? timeToX(Math.max(s.project.duration, inP ?? 0), v) : timeToX(outP, v)
  const top = SECTION_H
  const h = RULER_H - SECTION_H - 1
  ctx.fillStyle = 'rgba(139,108,255,0.22)'
  ctx.fillRect(x0, top, Math.max(0, x1 - x0), h)
  ctx.fillStyle = c.accent
  if (inP !== null) {
    ctx.fillRect(Math.round(x0), top, 2, h)
    ctx.fillRect(Math.round(x0), top, 6, 2)
  }
  if (outP !== null) {
    ctx.fillRect(Math.round(x1) - 2, top, 2, h)
    ctx.fillRect(Math.round(x1) - 6, top, 6, 2)
  }
}

function drawSections(ctx: CanvasRenderingContext2D, s: Scene): void {
  const { view: v, palette: c } = s
  ctx.save()
  ctx.beginPath()
  ctx.rect(0, 0, v.width, SECTION_H)
  ctx.clip()
  ctx.fillStyle = c.ruler
  ctx.fillRect(0, 0, v.width, SECTION_H)
  ctx.font = '9px "Inter Variable", Inter, system-ui, sans-serif'
  ctx.textBaseline = 'middle'
  for (const sec of s.sections) {
    const x0 = timeToX(sec.start, v)
    const x1 = timeToX(sec.end, v)
    if (x1 < 0 || x0 > v.width) continue
    const w = x1 - x0
    ctx.fillStyle = SECTION_COLORS[sec.label] ?? SECTION_COLORS.other!
    ctx.globalAlpha = 0.35 + 0.5 * sec.energy
    ctx.fillRect(x0, 1, Math.max(1, w - 1), SECTION_H - 2)
    ctx.globalAlpha = 1
    if (w > 28) {
      ctx.save()
      ctx.beginPath()
      ctx.rect(x0, 0, w - 1, SECTION_H)
      ctx.clip()
      ctx.fillStyle = '#ffffff'
      ctx.fillText(sec.label, Math.max(x0, 0) + 4, SECTION_H / 2 + 0.5)
      ctx.restore()
    }
  }
  ctx.restore()
}

/** Высота треугольника маркера клипа от силы. */
function triHeight(strength: number): number {
  return 4 + 8 * strength
}

/** Маркеры клипов: тонкие линии вниз через все дорожки (яркость = сила) и треугольники у верха клипа. */
function drawMarkerLines(ctx: CanvasRenderingContext2D, s: Scene): void {
  const { view: v } = s
  for (const m of s.markers) {
    if (m.clipId === null) {
      drawLine(ctx, m, v.height)
      continue
    }
    const h = triHeight(m.strength)
    drawLine(ctx, { ...m, lineFrom: m.bandTop + h }, v.height)
    ctx.globalAlpha = 0.55 + 0.45 * m.strength
    ctx.fillStyle = m.color
    ctx.beginPath()
    ctx.moveTo(m.x - 4, m.bandTop)
    ctx.lineTo(m.x + 4, m.bandTop)
    ctx.lineTo(m.x, m.bandTop + h)
    ctx.closePath()
    ctx.fill()
    if (m.selected) {
      ctx.globalAlpha = 1
      ctx.strokeStyle = '#ffffff'
      ctx.lineWidth = 1.5
      ctx.stroke()
      ctx.lineWidth = 1
    }
    ctx.globalAlpha = 1
    if (m.label) drawMarkerLabel(ctx, m, m.bandTop + 20)
  }
}

function drawLine(ctx: CanvasRenderingContext2D, m: MarkerView, bottom: number): void {
  const x = Math.round(m.x)
  ctx.globalAlpha = m.selected ? 0.9 : 0.1 + 0.35 * m.strength
  ctx.fillStyle = m.selected ? '#ffffff' : m.color
  ctx.fillRect(x, m.lineFrom, 1, bottom - m.lineFrom)
  ctx.globalAlpha = 1
}

function drawMarkerLabel(ctx: CanvasRenderingContext2D, m: MarkerView, y: number): void {
  if (!m.label) return
  ctx.font = '10px "Inter Variable", Inter, system-ui, sans-serif'
  ctx.textBaseline = 'middle'
  const w = ctx.measureText(m.label).width + 8
  ctx.fillStyle = 'rgba(0,0,0,0.55)'
  ctx.fillRect(m.x + 3, y - 7, w, 14)
  ctx.fillStyle = m.color
  ctx.fillText(m.label, m.x + 7, y)
}

/** Маркеры проекта — треугольники на линейке (линии вниз уже нарисованы вместе с дорожками). */
function drawRulerMarkers(ctx: CanvasRenderingContext2D, s: Scene): void {
  for (const m of s.markers) {
    if (m.clipId !== null) continue
    const h = 5 + 5 * m.strength
    ctx.fillStyle = m.color
    ctx.beginPath()
    ctx.moveTo(m.x - 4, m.bandTop)
    ctx.lineTo(m.x + 4, m.bandTop)
    ctx.lineTo(m.x, m.bandTop + h)
    ctx.closePath()
    ctx.fill()
    if (m.selected) {
      ctx.strokeStyle = '#ffffff'
      ctx.lineWidth = 1.5
      ctx.stroke()
      ctx.lineWidth = 1
    }
    if (m.label) drawMarkerLabel(ctx, m, m.bandTop - 0 + 6)
  }
}

interface ItemStyle {
  selected: boolean
  dim: boolean
  ghost: boolean
  invalid?: boolean
  locked: boolean
}

function drawItem(
  ctx: CanvasRenderingContext2D,
  s: Scene,
  item: TrackItem,
  start: number,
  top: number,
  height: number,
  st: ItemStyle,
): void {
  const { view: v, palette: c } = s
  const x0 = timeToX(start, v)
  const x1 = timeToX(start + item.duration, v)
  // отрисовываем только видимую часть (очень длинные клипы при большом зуме)
  const vx0 = Math.max(x0, -2)
  const vx1 = Math.min(x1, v.width + 2)
  if (vx1 <= vx0) return
  const y = top + 2
  const h = height - 4
  const w = vx1 - vx0
  const asset = isClip(item) ? s.assets(item.assetId) : undefined
  const base = item.type === 'effect' ? c.fx : asset?.kind === 'audio' ? c.audio : c.video

  ctx.save()
  ctx.globalAlpha = st.ghost ? 0.75 : st.dim ? 0.4 : 1
  ctx.beginPath()
  ctx.roundRect(vx0, y, w, h, 3)
  ctx.fillStyle = (isClip(item) && item.color) || base
  ctx.fill()
  ctx.save()
  ctx.clip()
  if (isClip(item) && asset) {
    if (asset.kind === 'audio') drawWaveform(ctx, s, item, asset, start, vx0, vx1, y, h)
    else drawThumbs(ctx, s, item, asset, start, vx0, vx1, y, h)
  }
  // подпись
  const label = isClip(item)
    ? (item.label ?? asset?.name ?? item.assetId)
    : (getEffectDef(item.effect)?.name ?? item.effect)
  if (w > 24) {
    ctx.fillStyle = 'rgba(0,0,0,0.45)'
    const tw = Math.min(ctx.measureText(label).width + 10, w)
    ctx.fillRect(vx0, y, tw, 16)
    ctx.fillStyle = c.text
    ctx.fillText(label, vx0 + 5, y + 8)
  }
  if (isClip(item) && (item.timeRemap || Math.abs(item.speed - 1) > EPS || item.reverse) && w > 60) {
    const tag = item.timeRemap ? 'ramp' : `${item.reverse ? '◀ ' : ''}${round2(item.speed)}×`
    ctx.fillStyle = 'rgba(0,0,0,0.45)'
    const tw = ctx.measureText(tag).width + 10
    ctx.fillRect(vx1 - tw, y, tw, 16)
    ctx.fillStyle = c.snap
    ctx.fillText(tag, vx1 - tw + 5, y + 8)
  }
  // ключевые кадры transform/opacity — ромбики у нижнего края клипа
  if (isClip(item) && !st.ghost) {
    const keyY = y + h - 6
    ctx.fillStyle = 'rgba(255,255,255,0.85)'
    ctx.strokeStyle = 'rgba(0,0,0,0.6)'
    for (const t of clipKeyTimes(item)) {
      const kx = timeToX(start + t, v)
      if (kx < vx0 - 4 || kx > vx1 + 4) continue
      diamond(ctx, kx, keyY, 3.5)
      ctx.fill()
      ctx.stroke()
    }
  }
  ctx.restore()
  ctx.lineWidth = st.selected ? 2 : 1
  ctx.strokeStyle = st.invalid ? c.playhead : st.selected ? '#ffffff' : 'rgba(0,0,0,0.5)'
  ctx.beginPath()
  ctx.roundRect(x0 + 0.5, y + 0.5, x1 - x0 - 1, h - 1, 3)
  ctx.stroke()
  ctx.restore()
}

function round2(n: number): string {
  return String(Math.round(n * 100) / 100)
}

function drawThumbs(
  ctx: CanvasRenderingContext2D,
  s: Scene,
  clip: Clip,
  asset: Asset,
  start: number,
  vx0: number,
  vx1: number,
  y: number,
  h: number,
): void {
  const thumbs = s.media.thumbs(asset)
  if (!thumbs) return
  const v = s.view
  const slotW = Math.max(8, (thumbs.tileWidth * h) / thumbs.tileHeight)
  const x0 = timeToX(start, v)
  const first = Math.max(0, Math.floor((vx0 - x0) / slotW))
  const shifted = { ...clip, start }
  for (let k = first; x0 + k * slotW < vx1; k++) {
    const sx = x0 + k * slotW
    const t = xToTime(Math.min(sx, vx1 - 1), v)
    const tile = s.media.tile(thumbs, sourceAtTimeline(shifted, t))
    if (!tile) continue
    const img = s.media.image(tile.sprite)
    if (!img) continue
    ctx.drawImage(img, tile.sx, tile.sy, tile.sw, tile.sh, sx, y, slotW, h)
  }
}

function drawWaveform(
  ctx: CanvasRenderingContext2D,
  s: Scene,
  clip: Clip,
  asset: Asset,
  start: number,
  vx0: number,
  vx1: number,
  y: number,
  h: number,
): void {
  const wf = s.media.waveform(asset)
  if (!wf || wf.peaks.length < 2) return
  const v = s.view
  const peakSec = wf.samplesPerPeak / wf.sampleRate
  const peaks = wf.peaks.length / 2
  const mid = y + h / 2 + 6
  const amp = (h - 16) / 2
  const shifted = { ...clip, start }
  ctx.fillStyle = 'rgba(210,255,230,0.55)'
  for (let x = Math.floor(vx0); x < vx1; x++) {
    const a = sourceAtTimeline(shifted, xToTime(x, v))
    const b = sourceAtTimeline(shifted, xToTime(x + 1, v))
    let i0 = Math.floor(Math.min(a, b) / peakSec)
    const i1 = Math.max(i0 + 1, Math.ceil(Math.max(a, b) / peakSec))
    let lo = 0
    let hi = 0
    for (i0 = Math.max(0, i0); i0 < Math.min(i1, peaks); i0++) {
      lo = Math.min(lo, wf.peaks[i0 * 2]!)
      hi = Math.max(hi, wf.peaks[i0 * 2 + 1]!)
    }
    const top = mid - (hi / 128) * amp
    const bot = mid - (lo / 128) * amp
    ctx.fillRect(x, top, 1, Math.max(1, bot - top))
  }
}

function diamond(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  ctx.beginPath()
  ctx.moveTo(x, y - r)
  ctx.lineTo(x + r, y)
  ctx.lineTo(x, y + r)
  ctx.lineTo(x - r, y)
  ctx.closePath()
}

const LANE_COLORS: Record<string, string> = {
  x: '#ff8a5c',
  y: '#5cc8ff',
  scale: '#b98cff',
  rotation: '#6fe0a0',
  opacity: '#ffd84d',
}

/** Дорожки свойств под видеодорожкой: фон, полоса клипа, кривая значения (нормированная по клипу). */
function drawLanes(ctx: CanvasRenderingContext2D, s: Scene, row: TrackRow, t0: number, t1: number): void {
  const { view: v, palette: c } = s
  for (const lane of row.lanes) {
    const top = laneScreenTop(row, lane, v)!
    ctx.fillStyle = 'rgba(0,0,0,0.22)'
    ctx.fillRect(0, top, v.width, LANE_H)
    ctx.fillStyle = c.border
    ctx.fillRect(0, top + LANE_H - 1, v.width, 1)
    for (const item of row.track.items) {
      if (!isClip(item) || itemEnd(item) < t0 || item.start > t1) continue
      const x0 = Math.max(timeToX(item.start, v), -2)
      const x1 = Math.min(timeToX(itemEnd(item), v), v.width + 2)
      if (x1 <= x0) continue
      ctx.fillStyle = s.selection.has(item.id) ? 'rgba(139,108,255,0.16)' : 'rgba(255,255,255,0.05)'
      ctx.fillRect(x0, top + 1, x1 - x0, LANE_H - 2)
      drawLaneCurve(ctx, s, item, lane, x0, x1, top)
    }
  }
}

function drawLaneCurve(
  ctx: CanvasRenderingContext2D,
  s: Scene,
  clip: Clip,
  lane: LaneProp,
  x0: number,
  x1: number,
  top: number,
): void {
  const v = s.view
  for (const field of LANE_FIELDS[lane]) {
    const a = clipAnimatable(clip, field)
    if (!isAnimated(a) || a.length < 2) continue
    let lo = Infinity
    let hi = -Infinity
    for (const k of a) {
      lo = Math.min(lo, k.v)
      hi = Math.max(hi, k.v)
    }
    if (hi - lo < 1e-9) continue
    ctx.strokeStyle = LANE_COLORS[field]!
    ctx.globalAlpha = 0.7
    ctx.lineWidth = 1
    ctx.beginPath()
    for (let x = x0; x <= x1; x += 3) {
      const val = evaluateAnimatable(a, xToTime(x, v) - clip.start)
      const y = top + LANE_H - 3 - ((val - lo) / (hi - lo)) * (LANE_H - 6)
      if (x === x0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    ctx.stroke()
    ctx.globalAlpha = 1
  }
}

/** Форма ключа по интерполяции: ромб — linear, квадрат — hold, круг — плавные (как в AE). */
function keyShape(ctx: CanvasRenderingContext2D, x: number, y: number, ease: Ease): void {
  if (ease === 'hold') {
    ctx.beginPath()
    ctx.rect(x - 3.5, y - 3.5, 7, 7)
  } else if (ease === 'linear') {
    diamond(ctx, x, y, 5)
  } else {
    ctx.beginPath()
    ctx.arc(x, y, 4, 0, Math.PI * 2)
  }
}

function drawKeys(ctx: CanvasRenderingContext2D, keys: readonly KeyView[], c: Palette): void {
  for (const k of keys) {
    keyShape(ctx, k.x, k.y, k.ease)
    ctx.fillStyle = k.selected ? c.snap : '#d8dbe4'
    ctx.fill()
    ctx.strokeStyle = k.selected ? '#ffffff' : 'rgba(0,0,0,0.7)'
    ctx.lineWidth = 1
    ctx.stroke()
  }
}
