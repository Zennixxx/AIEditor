import { describe, expect, it } from 'vitest'
import type { Asset, AssetParent, Clip, TimeRemap } from '@/shared/types.gen'
import {
  blendFrames,
  coversClip,
  interpolationRange,
  layerBlend,
  minEffectiveSpeed,
  requiredFactor,
  usableInterpolation,
} from './interpolation'
import { clip, videoAsset } from './testUtils'

const fsf: TimeRemap = {
  keyframes: [
    { u: 0, speed: 3, ease: 'easeInOut' },
    { u: 0.35, speed: 0.25, ease: 'hold' },
    { u: 0.65, speed: 0.25, ease: 'easeInOut' },
    { u: 1, speed: 3, ease: 'linear' },
  ],
  fit: 'free',
  frameBlend: true,
}

const DERIVED = 'ast_derived00000001'

function derived(parent: Partial<AssetParent> = {}, asset: Partial<Asset> = {}): Asset {
  return {
    ...videoAsset,
    id: DERIVED,
    fps: 120,
    hasAudio: false,
    parent: {
      assetId: videoAsset.id,
      kind: 'interpolated',
      factor: 4,
      sourceIn: 0.9,
      sourceOut: 3.1,
      ...parent,
    },
    ...asset,
  }
}

describe('interpolation (CONTRACT §5.3)', () => {
  it('finds the minimum effective speed of constant and ramped clips', () => {
    expect(minEffectiveSpeed(clip('c', 0, 4, { speed: 0.5 }))).toBe(0.5)
    expect(minEffectiveSpeed(clip('c', 0, 4, { timeRemap: fsf }))).toBeCloseTo(0.25, 9)
    const stretched = clip('c', 0, 4, { sourceIn: 0, sourceOut: 2, timeRemap: { ...fsf, fit: 'stretch' } })
    expect(minEffectiveSpeed(stretched)).toBeGreaterThan(0)
    expect(minEffectiveSpeed(stretched)).toBeLessThan(0.25)
  })

  it('computes the factor by the contract formula', () => {
    expect(requiredFactor(clip('c', 0, 4, { speed: 0.5 }), videoAsset, 30)).toBe(2)
    expect(requiredFactor(clip('c', 0, 4, { timeRemap: fsf }), videoAsset, 30)).toBe(4)
    expect(requiredFactor(clip('c', 0, 4, { speed: 0.3 }), videoAsset, 60)).toBe(8)
    expect(requiredFactor(clip('c', 0, 4, { speed: 0.01 }), videoAsset, 60)).toBe(16)
    expect(requiredFactor(clip('c', 0, 4, { speed: 0.85 }), videoAsset, 30)).toBeNull()
    expect(requiredFactor(clip('c', 0, 4, { speed: 0.5 }), { ...videoAsset, fps: 120 }, 30)).toBeNull()
    expect(requiredFactor(clip('c', 0, 4, { speed: 0.5 }), derived(), 30)).toBeNull()
    expect(requiredFactor(clip('c', 0, 4, { speed: 0.5 }), undefined, 30)).toBeNull()
  })

  it('pads the range by 0.1 s and clips it to the asset', () => {
    const r = interpolationRange(clip('c', 0, 2, { sourceIn: 1, sourceOut: 3 }), videoAsset)
    expect(r.sourceIn).toBeCloseTo(0.9, 9)
    expect(r.sourceOut).toBeCloseTo(3.1, 9)
    const edge = interpolationRange(clip('c', 0, 2, { sourceIn: 0, sourceOut: 10, speed: 5 }), videoAsset)
    expect(edge).toEqual({ sourceIn: 0, sourceOut: 10 })
  })

  it('uses a derived asset only while it covers the clip', () => {
    const c: Clip = clip('c', 0, 2, { sourceIn: 1, sourceOut: 3, interpolatedAssetId: DERIVED })
    expect(coversClip(derived(), c)).toBe(true)
    expect(coversClip(derived({ sourceIn: 1.2 }), c)).toBe(false)
    expect(coversClip(derived({ assetId: 'ast_other0000000001' }), c)).toBe(false)
    expect(coversClip(derived({}, { status: 'importing' }), c)).toBe(false)
    expect(coversClip(derived(), { ...c, reverse: true })).toBe(true)
    const whole = clip('w', 0, 10, { sourceIn: 0, sourceOut: 10 })
    expect(coversClip(derived({ sourceIn: 0, sourceOut: 9 + 29 / 30, factor: 8 }, { fps: 240 }), whole)).toBe(
      true,
    )
    expect(coversClip(derived({ sourceIn: 0, sourceOut: 9.9, factor: 8 }, { fps: 240 }), whole)).toBe(false)
    expect(usableInterpolation(c, () => derived())?.id).toBe(DERIVED)
    expect(usableInterpolation(c, () => undefined)).toBeNull()
    expect(usableInterpolation({ ...c, interpolatedAssetId: undefined }, () => derived())).toBeNull()
  })

  it('blends the two neighbour source frames by the fractional part', () => {
    const b = blendFrames(1 + 0.4 / 30, 30)!
    expect(b.next).toBeCloseTo(31 / 30, 9)
    expect(b.weight).toBeCloseTo(0.4, 6)
    expect(blendFrames(1, 30)).toBeNull()
    expect(blendFrames(1 + 0.999 / 30, 30)).toBeNull()
  })

  it('blends only slow parts of frame-blend ramps without a usable interpolation', () => {
    const lookup = (id: string) =>
      id === videoAsset.id ? videoAsset : id === DERIVED ? derived() : undefined
    const ramp = clip('c', 0, 2, { sourceIn: 1, sourceOut: 3, timeRemap: { ...fsf, fit: 'stretch' } })
    const src = 1 + 0.5 / 30
    expect(layerBlend(ramp, src, 0.25, lookup)?.weight).toBeCloseTo(0.5, 6)
    expect(layerBlend(ramp, src, 2, lookup)).toBeNull()
    expect(layerBlend(ramp, src, 0.25, undefined)).toBeNull()
    const noBlend = { ...ramp, timeRemap: { ...ramp.timeRemap!, frameBlend: false } }
    expect(layerBlend(noBlend, src, 0.25, lookup)).toBeNull()
    expect(layerBlend({ ...ramp, interpolatedAssetId: DERIVED }, src, 0.25, lookup)).toBeNull()
    expect(layerBlend(clip('c', 0, 4, { speed: 0.5 }), src, 0.5, lookup)).toBeNull()
  })
})
