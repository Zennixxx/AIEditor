// Ease-функции CONTRACT §2/§5.1 — те же шаги, что в backend/app/timeremap.py.
import type { Ease } from '@/shared/types.gen'

export const NAMED_BEZIER = {
  easeIn: [0.42, 0, 1, 1],
  easeOut: [0, 0, 0.58, 1],
  easeInOut: [0.42, 0, 0.58, 1],
} as const satisfies Record<string, readonly [number, number, number, number]>

/** y по x для CSS cubic-bezier (P0=(0,0), P3=(1,1)): 8 итераций Ньютона, затем бисекция до 1e-7. */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number, x: number): number {
  if (x <= 0) return 0
  if (x >= 1) return 1
  const bx = (t: number) => ((1 - 3 * x2 + 3 * x1) * t + (3 * x2 - 6 * x1)) * t * t + 3 * x1 * t
  const by = (t: number) => ((1 - 3 * y2 + 3 * y1) * t + (3 * y2 - 6 * y1)) * t * t + 3 * y1 * t
  const dbx = (t: number) => 3 * (1 - 3 * x2 + 3 * x1) * t * t + 2 * (3 * x2 - 6 * x1) * t + 3 * x1

  let t = x
  for (let i = 0; i < 8; i++) {
    const err = bx(t) - x
    if (Math.abs(err) < 1e-7) return by(t)
    const d = dbx(t)
    if (Math.abs(d) < 1e-6) break
    t -= err / d
  }
  let lo = 0
  let hi = 1
  t = x
  for (let i = 0; i < 60; i++) {
    const v = bx(t)
    if (Math.abs(v - x) < 1e-7) break
    if (v < x) lo = t
    else hi = t
    t = (lo + hi) / 2
  }
  return by(t)
}

/** Доля перехода к следующему ключу при параметре p ∈ [0, 1]. */
export function easeValue(ease: Ease, p: number): number {
  if (typeof ease === 'object') {
    const [x1 = 0, y1 = 0, x2 = 1, y2 = 1] = ease.bezier
    return cubicBezier(x1, y1, x2, y2, p)
  }
  switch (ease) {
    case 'linear':
      return p
    case 'hold':
      return p >= 1 ? 1 : 0
    default: {
      const [x1, y1, x2, y2] = NAMED_BEZIER[ease]
      return cubicBezier(x1, y1, x2, y2, p)
    }
  }
}
