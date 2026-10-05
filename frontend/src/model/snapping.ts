// Привязка (docs/FRONTEND.md 1.4): плейхед, края клипов, маркеры, секции, 0.
import type { Marker, Project } from '@/shared/types.gen'
import { snapToFrame } from '@/shared/time'
import { itemEnd, timelineAtSource } from './clipTime'
import { isClip } from './lookup'
import { sectionSpanOnTimeline } from './sections'

export type SnapKind = 'playhead' | 'edge' | 'marker' | 'section' | 'zero'

export interface SnapTarget {
  t: number
  kind: SnapKind
}

/** При равном расстоянии выигрывает цель с меньшим приоритетом (плейхед — первым). */
export const SNAP_PRIORITY: Record<SnapKind, number> = {
  playhead: 0,
  edge: 1,
  marker: 2,
  section: 3,
  zero: 4,
}

/** Порог привязки в экранных пикселях. */
export const SNAP_PX = 8

export function snapThreshold(pxPerSec: number, px = SNAP_PX): number {
  return px / pxPerSec
}

export interface CollectOptions {
  playhead: number
  /** Перетаскиваемые элементы — их края не являются целями. */
  exclude?: ReadonlySet<string>
  /** Скрытые фильтром видимости маркеры не являются целями привязки. */
  markerVisible?: (m: Marker) => boolean
  /** Маркеры, которые сейчас перетаскивают, — не цели. */
  excludeMarkers?: ReadonlySet<string>
}

/** Все цели привязки в timeline time. Маркеры клипов (source time) пересчитываются в timeline time. */
export function collectSnapTargets(p: Project, opts: CollectOptions): SnapTarget[] {
  const res: SnapTarget[] = [
    { t: opts.playhead, kind: 'playhead' },
    { t: 0, kind: 'zero' },
  ]
  const usable = (m: Marker) =>
    !opts.excludeMarkers?.has(m.id) && (opts.markerVisible ? opts.markerVisible(m) : true)
  for (const track of p.tracks) {
    for (const item of track.items) {
      if (opts.exclude?.has(item.id)) continue
      res.push({ t: item.start, kind: 'edge' }, { t: itemEnd(item), kind: 'edge' })
      if (!isClip(item)) continue
      for (const m of item.markers) {
        if (!usable(m)) continue
        const t = timelineAtSource(item, m.t)
        if (t !== null) res.push({ t, kind: 'marker' })
      }
      // секции музыки клипа (source time) — в timeline time, обрезанные по видимому диапазону (CONTRACT §6.1 п. 11)
      for (const s of item.sections ?? []) {
        const span = sectionSpanOnTimeline(item, s)
        if (span) res.push({ t: span[0], kind: 'section' }, { t: span[1], kind: 'section' })
      }
    }
  }
  for (const m of p.markers) if (usable(m)) res.push({ t: m.t, kind: 'marker' })
  for (const s of p.sections) res.push({ t: s.start, kind: 'section' }, { t: s.end, kind: 'section' })
  return res
}

export interface SnapHit {
  target: SnapTarget
  /** Индекс края (в переданном массиве edges), который притянулся. */
  edge: number
  /** Сдвиг, который нужно прибавить ко всем краям. */
  delta: number
}

/**
 * Ближайшая цель для любого из краёв перетаскиваемого объекта в пределах порога.
 * Равные расстояния разрешаются приоритетом цели (плейхед важнее всего).
 */
export function findSnap(
  edges: readonly number[],
  targets: readonly SnapTarget[],
  threshold: number,
): SnapHit | null {
  let best: SnapHit | null = null
  let bestDist = Infinity
  for (let e = 0; e < edges.length; e++) {
    const edge = edges[e]!
    for (const target of targets) {
      const dist = Math.abs(target.t - edge)
      if (dist > threshold) continue
      const better =
        dist < bestDist - 1e-9 ||
        (Math.abs(dist - bestDist) <= 1e-9 &&
          best !== null &&
          SNAP_PRIORITY[target.kind] < SNAP_PRIORITY[best.target.kind])
      if (better) {
        best = { target, edge: e, delta: target.t - edge }
        bestDist = dist
      }
    }
  }
  return best
}

export interface SnapOptions {
  enabled: boolean
  threshold: number
  fps: number
}

export interface SnapResult {
  /** Итоговое значение (квантованное к кадру). */
  value: number
  /** Точка привязки для визуализации (жёлтая линия) или null. */
  snappedAt: number | null
}

/** Привязка начала объекта длительностью `duration` (проверяются оба края), затем квантование к кадру. */
export function snapSpan(
  start: number,
  duration: number,
  targets: readonly SnapTarget[],
  opts: SnapOptions,
): SnapResult {
  const hit = opts.enabled ? findSnap([start, start + duration], targets, opts.threshold) : null
  const value = snapToFrame(start + (hit?.delta ?? 0), opts.fps)
  return { value, snappedAt: hit ? hit.target.t : null }
}

/** Привязка одной точки (край при триме, лезвие), затем квантование к кадру. */
export function snapPoint(t: number, targets: readonly SnapTarget[], opts: SnapOptions): SnapResult {
  return snapSpan(t, 0, targets, opts)
}
