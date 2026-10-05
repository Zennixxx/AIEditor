// Математика speed ramp — строго по CONTRACT §5.1 (эталон: backend/app/timeremap.py).
// Проверяется векторами shared/fixtures/time_remap_vectors.json.
import type { RampKeyframe, TimeRemap, TimeRemapFit } from '@/shared/types.gen'
import { easeValue } from './easing'

export const SIMPSON_STEPS = 256

/** Профиль скорости s(u). */
export function speedAt(keys: readonly RampKeyframe[], u: number): number {
  const first = keys[0]
  const last = keys[keys.length - 1]
  if (!first || !last) return 1
  if (u <= first.u) return first.speed
  if (u >= last.u) return last.speed
  for (let i = 0; i + 1 < keys.length; i++) {
    const a = keys[i]!
    const b = keys[i + 1]!
    if (a.u <= u && u <= b.u) {
      const span = b.u - a.u
      if (span <= 0) return b.speed
      const p = (u - a.u) / span
      return a.speed + (b.speed - a.speed) * easeValue(a.ease, p)
    }
  }
  return last.speed
}

/** Значение s(u) как предел слева — чтобы `hold` не схлопывал последний отрезок. */
function leftLimit(keys: readonly RampKeyframe[], u: number): number {
  for (let i = 0; i + 1 < keys.length; i++) {
    const a = keys[i]!
    const b = keys[i + 1]!
    if (a.u < u && u <= b.u) {
      const p = (u - a.u) / (b.u - a.u)
      const e = a.ease === 'hold' && p >= 1 ? 0 : easeValue(a.ease, p)
      return a.speed + (b.speed - a.speed) * e
    }
  }
  return speedAt(keys, u)
}

function simpson(keys: readonly RampKeyframe[], a: number, b: number): number {
  if (b <= a) return 0
  const n = SIMPSON_STEPS
  const h = (b - a) / n
  let total = speedAt(keys, a) + leftLimit(keys, b)
  for (let i = 1; i < n; i++) total += (i % 2 ? 4 : 2) * speedAt(keys, a + i * h)
  return (total * h) / 3
}

/** S(u) = ∫₀ᵘ s(x) dx — Симпсон по каждому интервалу между ключами. */
export function integral(keys: readonly RampKeyframe[], u: number): number {
  const uu = Math.min(Math.max(u, 0), 1)
  let total = 0
  for (let i = 0; i + 1 < keys.length; i++) {
    const a = keys[i]!
    const b = keys[i + 1]!
    if (uu <= a.u) break
    total += simpson(keys, a.u, Math.min(uu, b.u))
  }
  return total
}

export interface RemapSolution {
  /** Множитель скорости. */
  k: number
  /** sourceOut (для fit=free — вычисленный). */
  sourceOut: number
  /** S(1). */
  total: number
}

export function solveRemap(
  keys: readonly RampKeyframe[],
  fit: TimeRemapFit,
  duration: number,
  sourceIn: number,
  sourceOut: number,
): RemapSolution {
  const total = integral(keys, 1)
  if (fit === 'stretch') return { k: (sourceOut - sourceIn) / (duration * total), sourceOut, total }
  return { k: 1, sourceOut: sourceIn + duration * total, total }
}

export interface RemapClipLike {
  duration: number
  sourceIn: number
  sourceOut: number
  reverse: boolean
}

/** src(τ) для τ ∈ [0, D] от начала клипа (CONTRACT §5.1), с учётом reverse. */
export function remapSourceTime(remap: TimeRemap, clip: RemapClipLike, tau: number): number {
  const D = clip.duration
  const res = solveRemap(remap.keyframes, remap.fit, D, clip.sourceIn, clip.sourceOut)
  const t = Math.min(Math.max(tau, 0), D)
  const src = clip.sourceIn + D * res.k * integral(remap.keyframes, t / D)
  return clip.reverse ? res.sourceOut - (src - clip.sourceIn) : src
}

/**
 * Ключи ramp-профиля на отрезке u ∈ [u0, u1], перенормированные в [0, 1].
 * Граничные ключи получают точную скорость s(u0)/s(u1); ease разрезанного интервала сохраняется
 * (для linear/hold результат точный, для Безье — приближение формы внутри интервала).
 */
export function restrictKeyframes(keys: readonly RampKeyframe[], u0: number, u1: number): RampKeyframe[] {
  const span = u1 - u0
  const easeAt = (u: number) => {
    let ease = keys[0]?.ease ?? 'linear'
    for (const k of keys) if (k.u <= u) ease = k.ease
    return ease
  }
  const res: RampKeyframe[] = [{ u: 0, speed: speedAt(keys, u0), ease: easeAt(u0) }]
  for (const k of keys) {
    if (k.u > u0 + 1e-9 && k.u < u1 - 1e-9) res.push({ ...k, u: (k.u - u0) / span })
  }
  res.push({ u: 1, speed: span > 0 ? leftLimit(keys, u1) : speedAt(keys, u1), ease: easeAt(u1) })
  return res
}
