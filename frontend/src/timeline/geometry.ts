// Геометрия таймлайна: время ↔ пиксели, раскладка дорожек, хит-тест. Без React и Canvas.
import { itemEnd } from '@/model/clipTime'
import { displayOrder } from '@/model/tracks'
import type { Project, Track, TrackItem, TrackKind } from '@/shared/types.gen'

export const RULER_H = 28
export const TRACK_H: Record<TrackKind, number> = { video: 64, audio: 56, fx: 30 }
/** Зона трима у края элемента, px. */
export const EDGE_PX = 6

export interface View {
  pxPerSec: number
  /** Время у левого края, сек. */
  scrollX: number
  /** Вертикальный скролл дорожек, px. */
  scrollY: number
  width: number
  height: number
}

export function timeToX(t: number, v: Pick<View, 'pxPerSec' | 'scrollX'>): number {
  return (t - v.scrollX) * v.pxPerSec
}

export function xToTime(x: number, v: Pick<View, 'pxPerSec' | 'scrollX'>): number {
  return x / v.pxPerSec + v.scrollX
}

export interface TrackRow {
  track: Track
  /** Верх дорожки в координатах содержимого (0 — под линейкой, без учёта scrollY). */
  top: number
  height: number
  index: number
}

export function layoutTracks(p: Pick<Project, 'tracks'>): TrackRow[] {
  let top = 0
  return displayOrder(p).map((track, index) => {
    const row = { track, top, height: TRACK_H[track.kind], index }
    top += row.height
    return row
  })
}

export function contentHeight(rows: readonly TrackRow[]): number {
  const last = rows[rows.length - 1]
  return last ? last.top + last.height : 0
}

/** Экранный y верха дорожки (canvas-координаты). */
export function rowScreenTop(row: TrackRow, v: Pick<View, 'scrollY'>): number {
  return RULER_H + row.top - v.scrollY
}

export function rowAtY(rows: readonly TrackRow[], y: number, v: Pick<View, 'scrollY'>): TrackRow | null {
  const cy = y - RULER_H + v.scrollY
  return rows.find((r) => cy >= r.top && cy < r.top + r.height) ?? null
}

export function maxScrollY(rows: readonly TrackRow[], v: Pick<View, 'height'>): number {
  return Math.max(0, contentHeight(rows) - (v.height - RULER_H) + 24)
}

export type Hit =
  | { area: 'ruler'; t: number }
  | { area: 'item'; row: TrackRow; item: TrackItem; zone: 'start' | 'end' | 'body'; t: number }
  | { area: 'track'; row: TrackRow; t: number }
  | { area: 'empty'; t: number }

export function hitTest(rows: readonly TrackRow[], v: View, x: number, y: number): Hit {
  const t = xToTime(x, v)
  if (y < RULER_H) return { area: 'ruler', t }
  const row = rowAtY(rows, y, v)
  if (!row) return { area: 'empty', t }
  for (const item of row.track.items) {
    const x0 = timeToX(item.start, v)
    const x1 = timeToX(itemEnd(item), v)
    if (x < x0 || x > x1) continue
    // у коротких элементов зона трима не больше трети ширины
    const edge = Math.min(EDGE_PX, (x1 - x0) / 3)
    const zone = x - x0 <= edge ? 'start' : x1 - x <= edge ? 'end' : 'body'
    return { area: 'item', row, item, zone, t }
  }
  return { area: 'track', row, t }
}

/** Элементы, пересекающие прямоугольник (canvas-координаты) — для рамки выделения. */
export function itemsInRect(
  rows: readonly TrackRow[],
  v: View,
  rect: { x0: number; y0: number; x1: number; y1: number },
): string[] {
  const t0 = xToTime(Math.min(rect.x0, rect.x1), v)
  const t1 = xToTime(Math.max(rect.x0, rect.x1), v)
  const yTop = Math.min(rect.y0, rect.y1)
  const yBot = Math.max(rect.y0, rect.y1)
  const res: string[] = []
  for (const row of rows) {
    if (row.track.locked) continue
    const top = rowScreenTop(row, v)
    if (top + row.height < yTop || top > yBot) continue
    for (const item of row.track.items) if (item.start < t1 && itemEnd(item) > t0) res.push(item.id)
  }
  return res
}

/**
 * Автоскролл при воспроизведении: если плейхед ушёл за правый край (или левее левого) —
 * перелистываем так, чтобы он оказался у левого края с небольшим отступом.
 */
export function followPlayhead(v: Pick<View, 'pxPerSec' | 'scrollX' | 'width'>, playhead: number): number {
  const x = timeToX(playhead, v)
  const margin = Math.min(40, v.width * 0.05)
  if (x >= 0 && x <= v.width - margin) return v.scrollX
  return Math.max(0, playhead - margin / v.pxPerSec)
}

/** Зум «вписать всё»: вся композиция в ширину с запасом 5%. */
export function fitZoom(duration: number, width: number): number {
  return width / Math.max(duration * 1.05, 1)
}
