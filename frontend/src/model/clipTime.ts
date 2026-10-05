// Пересчёт timeline time ↔ source time для клипа (CONTRACT §1, §2 инвариант 4, §5.1).
import type { Clip, TrackItem } from '@/shared/types.gen'
import { integral, remapSourceTime, solveRemap, speedAt } from './timeRemap'

export const EPS = 1e-6

export function itemEnd(item: Pick<TrackItem, 'start' | 'duration'>): number {
  return item.start + item.duration
}

type ClipTiming = Pick<Clip, 'duration' | 'sourceIn' | 'sourceOut' | 'speed' | 'reverse' | 'timeRemap'>

/**
 * «Прямая» позиция в исходнике через τ секунд от начала клипа, без учёта reverse:
 * sourceIn + потреблённый к τ объём исходника.
 */
export function forwardSource(clip: ClipTiming, tau: number): number {
  const D = clip.duration
  const t = Math.min(Math.max(tau, 0), D)
  const r = clip.timeRemap
  if (!r) return clip.sourceIn + t * clip.speed
  const { k } = solveRemap(r.keyframes, r.fit, D, clip.sourceIn, clip.sourceOut)
  return clip.sourceIn + D * k * integral(r.keyframes, t / D)
}

/** Фактический sourceOut (для timeRemap.fit="free" — вычисленный). */
export function effectiveSourceOut(clip: ClipTiming): number {
  const r = clip.timeRemap
  if (!r) return clip.sourceOut
  return solveRemap(r.keyframes, r.fit, clip.duration, clip.sourceIn, clip.sourceOut).sourceOut
}

/** Эффективная скорость на краю клипа (0 — начало, 1 — конец), сек исходника на сек таймлайна. */
export function edgeSpeed(clip: ClipTiming, edge: 0 | 1): number {
  const r = clip.timeRemap
  if (!r) return clip.speed
  const { k } = solveRemap(r.keyframes, r.fit, clip.duration, clip.sourceIn, clip.sourceOut)
  return k * speedAt(r.keyframes, edge)
}

/** Source time кадра клипа в момент `tau` от его начала (с учётом reverse и timeRemap). */
export function sourceAtLocal(clip: ClipTiming, tau: number): number {
  if (clip.timeRemap) return remapSourceTime(clip.timeRemap, clip, tau)
  const fwd = forwardSource(clip, tau)
  return clip.reverse ? clip.sourceOut - (fwd - clip.sourceIn) : fwd
}

/** Source time в момент timeline time `t` (без проверки попадания в клип). */
export function sourceAtTimeline(clip: ClipTiming & Pick<Clip, 'start'>, t: number): number {
  return sourceAtLocal(clip, t - clip.start)
}

/**
 * Timeline time, на котором показывается source time `src`, или null, если `src` вне диапазона клипа.
 * Используется для маркеров клипа (они хранятся в source time).
 */
export function timelineAtSource(clip: ClipTiming & Pick<Clip, 'start'>, src: number): number | null {
  const out = effectiveSourceOut(clip)
  if (src < clip.sourceIn - EPS || src > out + EPS) return null
  // «прямая» позиция, которую нужно найти
  const target = clip.reverse ? out - (src - clip.sourceIn) : src
  if (!clip.timeRemap) {
    return clip.start + (target - clip.sourceIn) / clip.speed
  }
  // forwardSource монотонна по τ (speed > 0) — бисекция
  let lo = 0
  let hi = clip.duration
  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2
    if (forwardSource(clip, mid) < target) lo = mid
    else hi = mid
  }
  return clip.start + (lo + hi) / 2
}
