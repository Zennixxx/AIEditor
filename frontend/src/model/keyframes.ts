// Ключевые кадры Animatable (CONTRACT §2): t — время от начала клипа на таймлайне.
import type { Animatable, Clip, ClipPatch, Ease, Keyframe } from '@/shared/types.gen'
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

// --- правка ключей (UI ключевых кадров transform/opacity, FRONTEND.md §4.2) ---

/** Анимируемые свойства видеоклипа. */
export type AnimProp = 'x' | 'y' | 'scale' | 'rotation' | 'opacity'
export const ANIM_PROPS: readonly AnimProp[] = ['x', 'y', 'scale', 'rotation', 'opacity']

/** Дорожки свойств на таймлайне: позиция объединяет x и y (как в AE). */
export type LaneProp = 'position' | 'scale' | 'rotation' | 'opacity'
export const LANE_PROPS: readonly LaneProp[] = ['position', 'scale', 'rotation', 'opacity']
export const LANE_FIELDS: Record<LaneProp, readonly AnimProp[]> = {
  position: ['x', 'y'],
  scale: ['scale'],
  rotation: ['rotation'],
  opacity: ['opacity'],
}

/** Ключи на одном времени (в пределах этой точности) считаются одним ключом. */
export const KEY_EPS = 1e-4

export function isAnimated(value: Animatable): value is Keyframe[] {
  return typeof value !== 'number'
}

export function clipAnimatable(clip: Pick<Clip, 'transform' | 'opacity'>, prop: AnimProp): Animatable {
  return prop === 'opacity' ? clip.opacity : clip.transform[prop]
}

/** Патч updateClip, заменяющий одно свойство. */
export function animPatch(clip: Pick<Clip, 'transform'>, prop: AnimProp, value: Animatable): ClipPatch {
  return prop === 'opacity' ? { opacity: value } : { transform: { ...clip.transform, [prop]: value } }
}

export function keyTimes(value: Animatable): number[] {
  return isAnimated(value) ? value.map((k) => k.t) : []
}

export function keyAt(value: Animatable, t: number): Keyframe | undefined {
  return isAnimated(value) ? value.find((k) => Math.abs(k.t - t) <= KEY_EPS) : undefined
}

function sorted(keys: Keyframe[]): Keyframe[] {
  return keys.sort((a, b) => a.t - b.t)
}

/** Ключ `v` во время `t`: заменяет ключ на том же времени (его ease сохраняется), иначе вставляется. */
export function setKey(value: Animatable, t: number, v: number, ease?: Ease): Keyframe[] {
  if (!isAnimated(value)) return [{ t, v, ease: ease ?? 'linear' }]
  const keys = value.map((k) => ({ ...k }))
  const same = keys.find((k) => Math.abs(k.t - t) <= KEY_EPS)
  if (same) {
    same.v = v
    if (ease) same.ease = ease
    return keys
  }
  // новый ключ продолжает интерполяцию предыдущего
  const prev = [...keys].reverse().find((k) => k.t < t)
  keys.push({ t, v, ease: ease ?? prev?.ease ?? 'linear' })
  return sorted(keys)
}

/** Удалить ключ на времени `t`; последний ключ превращает свойство в константу его значения. */
export function removeKey(value: Animatable, t: number): Animatable {
  if (!isAnimated(value)) return value
  const keys = value.filter((k) => Math.abs(k.t - t) > KEY_EPS)
  if (keys.length === value.length) return value
  return keys.length > 0 ? keys.map((k) => ({ ...k })) : evaluateAnimatable(value, t)
}

export function setKeyEase(value: Animatable, t: number, ease: Ease): Animatable {
  if (!isAnimated(value)) return value
  return value.map((k) => (Math.abs(k.t - t) <= KEY_EPS ? { ...k, ease } : { ...k }))
}

/** Значение во время `t`: у константы — новая константа, у анимированного — ключ (автоключ, как в AE). */
export function setValueAt(value: Animatable, t: number, v: number): Animatable {
  return isAnimated(value) ? setKey(value, t, v) : v
}

/** «Секундомер»: включить анимацию (ключ с текущим значением в `t`) или выключить (константа значения в `t`). */
export function toggleAnimation(value: Animatable, t: number): Animatable {
  return isAnimated(value) ? evaluateAnimatable(value, t) : [{ t, v: value, ease: 'linear' }]
}

/**
 * Сдвиг ключей с временами `times` на `delta` (с ограничением `[0, maxT]`). Неподвижный ключ, на чьё время
 * попал сдвинутый, заменяется (как в AE).
 */
export function shiftKeys(
  value: Animatable,
  times: readonly number[],
  delta: number,
  maxT: number,
): Animatable {
  if (!isAnimated(value) || times.length === 0) return value
  const moving = (k: Keyframe) => times.some((t) => Math.abs(k.t - t) <= KEY_EPS)
  const moved = value.filter(moving).map((k) => ({ ...k, t: Math.min(Math.max(k.t + delta, 0), maxT) }))
  if (moved.length === 0) return value
  const rest = value
    .filter((k) => !moving(k) && !moved.some((m) => Math.abs(m.t - k.t) <= KEY_EPS))
    .map((k) => ({ ...k }))
  return sorted([...rest, ...moved])
}

/** Ближайшее время ключа строго до/после `t` среди `times` (null — нет). */
export function neighborKey(times: readonly number[], t: number, dir: 1 | -1): number | null {
  let best: number | null = null
  for (const k of times) {
    if (dir > 0 ? k > t + KEY_EPS : k < t - KEY_EPS) {
      if (best === null || (dir > 0 ? k < best : k > best)) best = k
    }
  }
  return best
}
