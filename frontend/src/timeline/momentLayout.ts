// Моменты ИИ-анализа на видеоклипах таймлайна: полоски под подписью клипа, яркость — score.
import { effectiveSourceOut, timelineAtSource } from '@/model/clipTime'
import type { Clip, ClipAnalysis } from '@/shared/types.gen'
import { rowScreenTop, timeToX, type TrackRow, type View } from './geometry'

export const MOMENT_Y = 18
export const MOMENT_H = 4

export interface MomentRect {
  x0: number
  x1: number
  y: number
  score: number
  description: string
  tags: readonly string[]
}

/** Прямоугольники моментов клипа в экранных координатах (только видимая часть клипа). */
export function momentRects(
  clip: Clip,
  start: number,
  top: number,
  v: View,
  moments: ClipAnalysis['moments'],
): MomentRect[] {
  const placed = { ...clip, start }
  const clipX0 = timeToX(start, v)
  const clipX1 = timeToX(start + clip.duration, v)
  const out: MomentRect[] = []
  const srcOut = effectiveSourceOut(clip)
  for (const m of moments) {
    const lo = Math.max(m.start, clip.sourceIn)
    const hi = Math.min(m.end, srcOut)
    if (hi <= lo) continue
    const a = timelineAtSource(placed, lo)
    const b = timelineAtSource(placed, hi)
    if (a === null || b === null) continue
    const t0 = Math.min(a, b)
    const t1 = Math.max(a, b)
    const x0 = Math.max(timeToX(t0, v), clipX0 + 1)
    const x1 = Math.min(timeToX(t1, v), clipX1 - 1)
    if (x1 - x0 < 1) continue
    out.push({ x0, x1, y: top + 2 + MOMENT_Y, score: m.score, description: m.description, tags: m.tags })
  }
  return out
}

/** Момент под курсором: подсказка при наведении. */
export function hitMoment(
  rows: readonly TrackRow[],
  v: View,
  x: number,
  y: number,
  analysis: (assetId: string) => ClipAnalysis | undefined,
): MomentRect | null {
  for (const row of rows) {
    if (row.track.kind !== 'video') continue
    const top = rowScreenTop(row, v)
    if (y < top + MOMENT_Y - 1 || y > top + MOMENT_Y + MOMENT_H + 4) continue
    for (const item of row.track.items) {
      if (item.type !== 'clip') continue
      const moments = analysis(item.assetId)?.moments
      if (!moments?.length) continue
      const hit = momentRects(item, item.start, top, v, moments).find(
        (r) => x >= r.x0 && x <= r.x1 && y >= r.y - 2 && y <= r.y + MOMENT_H + 2,
      )
      if (hit) return hit
    }
  }
  return null
}
