import { describe, expect, it } from 'vitest'
import type { Envelope } from '@/shared/types.gen'
import { effectIntensity, envelopeAt } from './envelope'

const env = (curve: Envelope['curve'], attack = 0.1, hold = 0.1, decay = 0.2): Envelope => ({
  attack,
  hold,
  decay,
  curve,
})

describe('envelopeAt (CONTRACT §2.1)', () => {
  it('is zero outside [0, duration)', () => {
    const e = env('linear')
    expect(envelopeAt(e, 0.4, -0.01)).toBe(0)
    expect(envelopeAt(e, 0.4, 0.4)).toBe(0)
    expect(envelopeAt(e, 0.4, 1)).toBe(0)
  })

  it('linear: attack → hold → decay → 0', () => {
    const e = env('linear')
    expect(envelopeAt(e, 0.5, 0)).toBe(0)
    expect(envelopeAt(e, 0.5, 0.05)).toBeCloseTo(0.5)
    expect(envelopeAt(e, 0.5, 0.15)).toBe(1)
    expect(envelopeAt(e, 0.5, 0.3)).toBeCloseTo(0.5)
    expect(envelopeAt(e, 0.5, 0.45)).toBe(0) // хвост после A+H+R
  })

  it('easeOut and exp start fast and are monotonic in decay', () => {
    for (const curve of ['easeOut', 'exp'] as const) {
      const e = env(curve, 0, 0, 1)
      expect(envelopeAt(e, 1, 0)).toBeCloseTo(1)
      expect(envelopeAt(e, 1, 0.5)).toBeLessThan(0.5)
      let prev = 1
      for (let t = 0; t < 1; t += 0.05) {
        const v = envelopeAt(e, 1, t)
        expect(v).toBeLessThanOrEqual(prev + 1e-12)
        prev = v
      }
      expect(envelopeAt(e, 1, 0.999)).toBeLessThan(0.01)
    }
    expect(envelopeAt(env('easeOut', 0, 0, 1), 1, 0.5)).toBeCloseTo(0.25)
    expect(envelopeAt(env('exp', 0, 0, 1), 1, 0.2)).toBeCloseTo(
      (Math.exp(-1) - Math.exp(-5)) / (1 - Math.exp(-5)),
    )
  })

  it('phases are clipped by a shorter duration', () => {
    const e = env('linear', 0.2, 0.2, 0.2)
    // D = 0.3: A = 0.2, H = 0.1, R = 0
    expect(envelopeAt(e, 0.3, 0.1)).toBeCloseTo(0.5)
    expect(envelopeAt(e, 0.3, 0.25)).toBe(1)
  })

  it('zero attack starts at full', () => {
    expect(envelopeAt(env('exp', 0, 0.05, 0.3), 0.35, 0)).toBe(1)
  })
})

describe('effectIntensity', () => {
  const base = { effect: 'shake', duration: 0.4, envelope: env('linear', 0, 0.4, 0) }
  it('multiplies by strength, default from the registry', () => {
    expect(effectIntensity({ ...base, params: {} }, 0.1)).toBe(1)
    expect(effectIntensity({ ...base, params: { strength: 1.5 } }, 0.1)).toBe(1.5)
  })
  it('transitions have no strength → 1', () => {
    expect(effectIntensity({ ...base, effect: 'whipPan', params: {} }, 0.1)).toBe(1)
  })
})
