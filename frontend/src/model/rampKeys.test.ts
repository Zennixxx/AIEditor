import { describe, expect, it } from 'vitest'
import type { TimeRemap } from '@/shared/types.gen'
import {
  addRampKey,
  constantRamp,
  easeBezier,
  moveRampKey,
  removeRampKey,
  setRampKeyEase,
  setSegmentHandle,
  snapToMarker,
} from './rampKeys'
import { speedAt } from './timeRemap'

const ramp = (): TimeRemap => ({
  keyframes: [
    { u: 0, speed: 2, ease: 'linear' },
    { u: 0.5, speed: 0.5, ease: 'easeInOut' },
    { u: 1, speed: 2, ease: 'linear' },
  ],
  fit: 'stretch',
  frameBlend: true,
})

describe('ramp key editing', () => {
  it('creates a flat curve from a constant speed', () => {
    const r = constantRamp(0.5)
    expect(r.keyframes.map((k) => [k.u, k.speed])).toEqual([
      [0, 0.5],
      [1, 0.5],
    ])
    expect(r.fit).toBe('stretch')
  })

  it('moves inner keys between neighbours and clamps speed; edge keys keep u', () => {
    const r = moveRampKey(ramp(), 1, 1.5, 50)
    expect(r.keyframes[1]!.u).toBeLessThan(1)
    expect(r.keyframes[1]!.speed).toBe(10)
    const edge = moveRampKey(ramp(), 0, 0.3, 0.01)
    expect(edge.keyframes[0]).toMatchObject({ u: 0, speed: 0.1 })
  })

  it('adds a key on the curve and removes only inner keys', () => {
    const { remap, index } = addRampKey(ramp(), 0.25)
    expect(index).toBe(1)
    expect(remap.keyframes).toHaveLength(4)
    expect(remap.keyframes[1]!.speed).toBeCloseTo(speedAt(ramp().keyframes, 0.25), 9)
    expect(addRampKey(ramp(), 0.5).index).toBe(-1)
    expect(removeRampKey(remap, 1).keyframes).toHaveLength(3)
    expect(removeRampKey(remap, 0)).toBe(remap)
    expect(removeRampKey(remap, 3)).toBe(remap)
  })

  it('edits ease and bezier handles of a segment', () => {
    expect(easeBezier('linear')).toBeNull()
    expect(easeBezier('easeIn')).toEqual([0.42, 0, 1, 1])
    const r = setSegmentHandle(ramp(), 1, 1, 0.2, 1.4)
    expect(r.keyframes[1]!.ease).toEqual({ bezier: [0.2, 1, 0.58, 1] })
    const r2 = setSegmentHandle(r, 1, 2, -1, 0.3)
    expect(r2.keyframes[1]!.ease).toEqual({ bezier: [0.2, 1, 0, 0.3] })
    expect(setRampKeyEase(ramp(), 0, 'hold').keyframes[0]!.ease).toBe('hold')
    expect(setSegmentHandle(ramp(), 2, 1, 0.5, 0.5)).toEqual(ramp())
  })

  it('snaps to the nearest marker within tolerance', () => {
    expect(snapToMarker(0.31, [0.1, 0.3, 0.33], 0.02)).toBe(0.3)
    expect(snapToMarker(0.5, [0.1, 0.3], 0.02)).toBeNull()
  })
})
