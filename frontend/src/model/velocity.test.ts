import { describe, expect, it } from 'vitest'
import { findRampPreset, rampPresets } from '@/shared/rampPresets'
import type { TimeRemap } from '@/shared/types.gen'
import { fitRampToMarkers, markersInClip, planVelocity, slowKeys } from './velocity'

const preset = (id: string): TimeRemap => findRampPreset(id)!.timeRemap
const us = (r: TimeRemap) => r.keyframes.map((k) => Number(k.u.toFixed(6)))

describe('velocity between markers', () => {
  it('loads all contract presets', () => {
    expect(rampPresets.map((p) => p.id)).toEqual([
      'fast-slow-fast',
      'slow-end',
      'ramp-to-drop',
      'slow-start',
      'pulse',
    ])
  })

  it('finds inner keys with the minimum speed', () => {
    expect(slowKeys(preset('fast-slow-fast').keyframes)).toEqual([1, 2])
    expect(slowKeys(preset('pulse').keyframes)).toEqual([1])
    expect(slowKeys(preset('slow-end').keyframes)).toEqual([])
  })

  it('puts the slow segment of fast-slow-fast between the nearest markers', () => {
    const { remap, matched } = fitRampToMarkers(preset('fast-slow-fast'), [0.25, 0.5, 0.75])
    expect(matched).toBe(2)
    expect(us(remap)).toEqual([0, 0.25, 0.75, 1])
    expect(remap.keyframes.map((k) => k.speed)).toEqual([3, 0.25, 0.25, 3])
  })

  it('centres the slow segment on a single marker keeping its width', () => {
    const { remap, matched } = fitRampToMarkers(preset('fast-slow-fast'), [0.4])
    expect(matched).toBe(2)
    expect(us(remap)).toEqual([0, 0.25, 0.55, 1])
  })

  it('moves a single slow key to the nearest marker', () => {
    const { remap } = fitRampToMarkers(preset('pulse'), [0.3, 0.62, 0.9])
    expect(us(remap)).toEqual([0, 0.62, 1])
  })

  it('keeps the preset when nothing can be matched', () => {
    expect(fitRampToMarkers(preset('fast-slow-fast'), []).matched).toBe(0)
    expect(us(fitRampToMarkers(preset('fast-slow-fast'), []).remap)).toEqual([0, 0.35, 0.65, 1])
    expect(fitRampToMarkers(preset('slow-end'), [0.5]).matched).toBe(0)
  })

  it('converts timeline markers inside the clip to u and builds one op', () => {
    const clip = { id: 'clp_a', start: 10, duration: 2 }
    expect(markersInClip(clip, [9, 10, 10.5, 11.5, 12, 13], 30)).toEqual([0.25, 0.75])
    const { ops, matched } = planVelocity(clip, preset('fast-slow-fast'), [10.5, 11.5], 30)
    expect(matched).toBe(2)
    expect(ops).toHaveLength(1)
    expect(ops[0]).toMatchObject({ op: 'setTimeRemap', clipId: 'clp_a' })
  })
})
