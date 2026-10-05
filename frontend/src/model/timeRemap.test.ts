import { describe, expect, it } from 'vitest'
import { fixtures } from '@/api/mocks/fixtures'
import { remapSourceTime, restrictKeyframes, solveRemap, speedAt } from './timeRemap'
import { cubicBezier } from './easing'

describe('timeRemap (CONTRACT §5.1)', () => {
  const { tolerance, vectors } = fixtures.timeRemapVectors

  it.each(vectors.map((v) => [v.name, v] as const))('matches reference vector %s', (_name, v) => {
    const clip = { duration: v.D, sourceIn: v.sourceIn, sourceOut: v.sourceOut, reverse: v.reverse }
    if (v.remap.fit === 'free') {
      const res = solveRemap(v.remap.keyframes, 'free', v.D, v.sourceIn, v.sourceOut)
      expect(Math.abs(res.sourceOut - v.sourceOut)).toBeLessThanOrEqual(tolerance)
    }
    for (const s of v.samples) {
      expect(Math.abs(remapSourceTime(v.remap, clip, s.tau) - s.src)).toBeLessThanOrEqual(tolerance)
    }
  })

  it('cubic-bezier is identity for linear control points and clamps', () => {
    expect(cubicBezier(0.25, 0.25, 0.75, 0.75, 0.3)).toBeCloseTo(0.3, 6)
    expect(cubicBezier(0.42, 0, 0.58, 1, 0)).toBe(0)
    expect(cubicBezier(0.42, 0, 0.58, 1, 1)).toBe(1)
  })

  it('restricts keyframes to a sub-range keeping boundary speeds', () => {
    const keys = [
      { u: 0, speed: 2, ease: 'linear' as const },
      { u: 1, speed: 4, ease: 'linear' as const },
    ]
    const left = restrictKeyframes(keys, 0, 0.5)
    expect(left.map((k) => [k.u, k.speed])).toEqual([
      [0, 2],
      [1, 3],
    ])
    const right = restrictKeyframes(keys, 0.5, 1)
    expect(speedAt(right, 0)).toBeCloseTo(3)
    expect(speedAt(right, 1)).toBeCloseTo(4)
  })
})
