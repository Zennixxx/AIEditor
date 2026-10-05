// Ключевые кадры Animatable (CONTRACT §2): t — время от начала клипа на таймлайне.
import type { Animatable, Keyframe } from '@/shared/types.gen'
import { easeValue } from './easing'

export function evaluateAnimatable(value: Animatable, t: number): number {
  if (typeof value === 'number') return value
  const first = value[0]
  const last = value[value.length - 1]
  if (!first || !last) return 0
  if (t <= first.t) return first.v
  if (t >= last.t) return last.v
  for (let i = 0; i + 1 < value.length; i++) {
    const a = value[i]!
    const b = value[i + 1]!
    if (a.t <= t && t <= b.t) {
      const span = b.t - a.t
      if (span <= 0) return b.v
      return a.v + (b.v - a.v) * easeValue(a.ease, (t - a.t) / span)
    }
  }
  return last.v
}

/**
 * Делит Animatable в точке `at` (от начала клипа): левая часть — ключи до `at` + граничный,
 * правая — ключи после `at`, сдвинутые к 0, + граничный в 0.
 */
export function splitAnimatable(value: Animatable, at: number): [Animatable, Animatable] {
  if (typeof value === 'number') return [value, value]
  const v = evaluateAnimatable(value, at)
  const easeAt = (): Keyframe['ease'] => {
    let ease: Keyframe['ease'] = value[0]?.ease ?? 'linear'
    for (const k of value) if (k.t <= at) ease = k.ease
    return ease
  }
  const left: Keyframe[] = value.filter((k) => k.t < at - 1e-9).map((k) => ({ ...k }))
  left.push({ t: at, v, ease: easeAt() })
  const right: Keyframe[] = [{ t: 0, v, ease: easeAt() }]
  for (const k of value) if (k.t > at + 1e-9) right.push({ ...k, t: k.t - at })
  return [left, right]
}
