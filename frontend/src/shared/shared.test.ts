import { describe, expect, it } from 'vitest'
import { fixtures } from '@/api/mocks/fixtures'
import { defaultParams, effectsByCategory, effectsRegistry, getEffectDef } from './effects-registry'
import { newId } from './ids'
import { formatTimecode, snapToFrame } from './time'

describe('effects registry', () => {
  it('has unique ids and known categories', () => {
    const ids = effectsRegistry.effects.map((e) => e.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect([...effectsByCategory().keys()].sort()).toEqual(
      ['camera', 'color', 'distort', 'light', 'stylize', 'transition'].sort(),
    )
  })

  it('builds default params with overrides', () => {
    expect(defaultParams('shake', { amount: 99 })).toMatchObject({
      amount: 99,
      frequency: 12,
      motionBlur: true,
    })
    expect(() => defaultParams('nope')).toThrow()
  })

  it('covers every effect used in the fixture project', () => {
    for (const track of fixtures.project.tracks) {
      for (const item of track.items) {
        const effects = item.type === 'effect' ? [item] : item.effects
        for (const fx of effects) expect(getEffectDef(fx.effect), fx.effect).toBeDefined()
      }
    }
  })
})

describe('time utils', () => {
  it('snaps to frame grid', () => {
    expect(snapToFrame(1.01, 30)).toBeCloseTo(1.0)
    expect(snapToFrame(1.02, 30)).toBeCloseTo(1 + 1 / 30)
  })

  it('formats timecode', () => {
    expect(formatTimecode(0, 30)).toBe('00:00:00')
    expect(formatTimecode(61.5, 30)).toBe('01:01:15')
    expect(formatTimecode(3600 + 2, 25)).toBe('1:00:02:00')
  })
})

describe('ids', () => {
  it('uses contract prefixes', () => {
    expect(newId('clp')).toMatch(/^clp_[0-9a-zA-Z]{10}$/)
    expect(newId('mrk')).not.toBe(newId('mrk'))
  })
})
