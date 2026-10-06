import type { Ease, RampKeyframe, TimeRemap } from '@/shared/types.gen'
import { NAMED_BEZIER } from './easing'
import { speedAt } from './timeRemap'

export const MIN_RAMP_SPEED = 0.1
export const MAX_RAMP_SPEED = 10
export const MIN_KEY_GAP = 0.002

export type Bezier = [number, number, number, number]

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi)
}

export function clampSpeed(speed: number): number {
  return clamp(speed, MIN_RAMP_SPEED, MAX_RAMP_SPEED)
}

function withKeys(remap: TimeRemap, keyframes: RampKeyframe[]): TimeRemap {
  return { ...remap, keyframes }
}

export function constantRamp(speed: number): TimeRemap {
  const s = clampSpeed(speed)
  return {
    keyframes: [
      { u: 0, speed: s, ease: 'linear' },
      { u: 1, speed: s, ease: 'linear' },
    ],
    fit: 'stretch',
    frameBlend: true,
  }
}

export function moveRampKey(remap: TimeRemap, index: number, u: number, speed: number): TimeRemap {
  const keys = remap.keyframes.map((k) => ({ ...k }))
  const key = keys[index]
  if (!key) return remap
  const last = keys.length - 1
  if (index > 0 && index < last) {
    const lo = keys[index - 1]!.u + MIN_KEY_GAP
    const hi = keys[index + 1]!.u - MIN_KEY_GAP
    key.u = lo <= hi ? clamp(u, lo, hi) : key.u
  }
  key.speed = clampSpeed(speed)
  return withKeys(remap, keys)
}

export function addRampKey(remap: TimeRemap, u: number): { remap: TimeRemap; index: number } {
  const keys = remap.keyframes
  const at = clamp(u, 0, 1)
  let i = keys.findIndex((k) => k.u > at)
  if (i <= 0) i = keys.length - 1
  const prev = keys[i - 1]!
  const next = keys[i]!
  if (at - prev.u < MIN_KEY_GAP || next.u - at < MIN_KEY_GAP) return { remap, index: -1 }
  const key: RampKeyframe = { u: at, speed: clampSpeed(speedAt(keys, at)), ease: prev.ease }
  const res = [...keys.slice(0, i), key, ...keys.slice(i)]
  return { remap: withKeys(remap, res), index: i }
}

export function removeRampKey(remap: TimeRemap, index: number): TimeRemap {
  if (index <= 0 || index >= remap.keyframes.length - 1) return remap
  return withKeys(
    remap,
    remap.keyframes.filter((_, i) => i !== index),
  )
}

export function setRampKeyEase(remap: TimeRemap, index: number, ease: Ease): TimeRemap {
  if (!remap.keyframes[index]) return remap
  return withKeys(
    remap,
    remap.keyframes.map((k, i) => (i === index ? { ...k, ease } : k)),
  )
}

export function easeBezier(ease: Ease): Bezier | null {
  if (typeof ease === 'object') {
    const [x1 = 0, y1 = 0, x2 = 1, y2 = 1] = ease.bezier
    return [x1, y1, x2, y2]
  }
  if (ease === 'linear' || ease === 'hold') return null
  return [...NAMED_BEZIER[ease]]
}

export function setSegmentHandle(
  remap: TimeRemap,
  index: number,
  handle: 1 | 2,
  x: number,
  y: number,
): TimeRemap {
  const key = remap.keyframes[index]
  if (!key || index >= remap.keyframes.length - 1) return remap
  const b = easeBezier(key.ease) ?? [0.25, 0.25, 0.75, 0.75]
  const cx = clamp(x, 0, 1)
  const cy = clamp(y, 0, 1)
  const bezier: Bezier = handle === 1 ? [cx, cy, b[2], b[3]] : [b[0], b[1], cx, cy]
  return setRampKeyEase(remap, index, { bezier: bezier.map((v) => Math.round(v * 1000) / 1000) })
}

export function snapToMarker(u: number, markers: readonly number[], tolerance: number): number | null {
  let best: number | null = null
  for (const m of markers) {
    if (Math.abs(m - u) <= tolerance && (best === null || Math.abs(m - u) < Math.abs(best - u))) best = m
  }
  return best
}
