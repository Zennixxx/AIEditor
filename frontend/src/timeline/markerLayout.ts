// Раскладка маркеров на экране: позиции, прореживание, хит-тест, рамка выделения. Без React и Canvas.
import {
  markerColor,
  thinMarkers,
  timelineMarkers,
  type MarkerVisibility,
  type TimelineMarker,
} from '@/model/markers'
import type { MarkerKind, Project } from '@/shared/types.gen'
import { isClip } from '@/model/lookup'
import { RULER_H, rowScreenTop, timeToX, type TrackRow, type View } from './geometry'

/** Прореживание: маркеры ближе этого расстояния (px) сливаются в кластер. */
export const MARKER_MIN_GAP_PX = 3
/** Радиус попадания курсора в маркер по X, px. */
export const MARKER_HIT_PX = 5
/** Высота зоны треугольников у верхнего края клипа, px. */
export const CLIP_MARKER_BAND = 16
/** Высота зоны маркеров проекта над нижним краем линейки, px. */
export const RULER_MARKER_BAND = 14

export interface MarkerView {
  id: string
  kind: MarkerKind
  strength: number
  color: string
  label?: string
  /** timeline time */
  t: number
  /** экранный x */
  x: number
  /** Клип-владелец или null (маркер проекта на линейке). */
  clipId: string | null
  selected: boolean
  /** Экранный y верха зоны треугольника (у маркера клипа — верх клипа, у маркера проекта — на линейке). */
  bandTop: number
  bandBottom: number
  /** Экранный y, с которого вниз рисуется тонкая линия через дорожки. */
  lineFrom: number
}

/**
 * Видимые (по фильтру) и прореженные при малом зуме маркеры в экранных координатах.
 * Скрытые фильтром маркеры не попадают в результат — их нет ни на экране, ни в хит-тесте.
 */
export function layoutMarkers(
  project: Project,
  rows: readonly TrackRow[],
  view: View,
  vis: MarkerVisibility,
  selected: ReadonlySet<string>,
): MarkerView[] {
  const margin = 12
  const clipRows = new Map<string, TrackRow>()
  for (const row of rows) {
    for (const item of row.track.items)
      if (isClip(item) && item.markers.length > 0) clipRows.set(item.id, row)
  }
  const inView: TimelineMarker[] = timelineMarkers(project, vis).filter((m) => {
    const x = timeToX(m.t, view)
    return x >= -margin && x <= view.width + margin
  })
  const res: MarkerView[] = []
  for (const m of thinMarkers(inView, view.pxPerSec, MARKER_MIN_GAP_PX, selected)) {
    const base = {
      id: m.marker.id,
      kind: m.marker.kind,
      strength: m.marker.strength,
      color: markerColor(m.marker),
      ...(m.marker.label ? { label: m.marker.label } : {}),
      t: m.t,
      x: timeToX(m.t, view),
      clipId: m.clipId,
      selected: selected.has(m.marker.id),
    }
    if (m.clipId === null) {
      res.push({
        ...base,
        bandTop: RULER_H - RULER_MARKER_BAND,
        bandBottom: RULER_H,
        lineFrom: RULER_H,
      })
      continue
    }
    const row = clipRows.get(m.clipId)
    if (!row) continue
    const top = rowScreenTop(row, view) + 2
    if (top > view.height || top + row.height < RULER_H) continue
    res.push({ ...base, bandTop: top, bandBottom: top + CLIP_MARKER_BAND, lineFrom: Math.max(top, RULER_H) })
  }
  return res
}

/** Маркер под курсором: ближайший по X в пределах MARKER_HIT_PX, y внутри зоны треугольника. */
export function hitMarker(markers: readonly MarkerView[], x: number, y: number): MarkerView | null {
  let best: MarkerView | null = null
  let bestDist = Infinity
  for (const m of markers) {
    if (y < m.bandTop || y > m.bandBottom) continue
    const d = Math.abs(m.x - x)
    if (d > MARKER_HIT_PX) continue
    if (d < bestDist - 1e-9 || (Math.abs(d - bestDist) <= 1e-9 && best && m.strength > best.strength)) {
      best = m
      bestDist = d
    }
  }
  return best
}

/**
 * Маркеры внутри рамки (Alt + drag): по X — любой маркер в диапазоне рамки; по Y — рамка пересекает
 * зону маркера (маркеры проекта — линейку, маркеры клипа — строку дорожки клипа).
 */
export function markersInRect(
  markers: readonly MarkerView[],
  rows: readonly TrackRow[],
  view: View,
  rect: { x0: number; y0: number; x1: number; y1: number },
): string[] {
  const xa = Math.min(rect.x0, rect.x1)
  const xb = Math.max(rect.x0, rect.x1)
  const ya = Math.min(rect.y0, rect.y1)
  const yb = Math.max(rect.y0, rect.y1)
  const rowOf = new Map<string, TrackRow>()
  for (const row of rows) for (const item of row.track.items) if (isClip(item)) rowOf.set(item.id, row)
  const res: string[] = []
  for (const m of markers) {
    if (m.x < xa || m.x > xb) continue
    let top = m.bandTop
    let bottom = m.bandBottom
    if (m.clipId !== null) {
      const row = rowOf.get(m.clipId)
      if (row) {
        top = rowScreenTop(row, view)
        bottom = top + row.height
      }
    }
    if (bottom >= ya && top <= yb) res.push(m.id)
  }
  return res
}
