import { describe, expect, it } from 'vitest'
import type { Keyframe } from '@/shared/types.gen'
import {
  clipKeyTimes,
  laneKeyEase,
  laneKeyTimes,
  planKeysEase,
  planRemoveKeys,
  planShiftKeys,
} from './clipKeys'
import {
  animPatch,
  evaluateAnimatable,
  neighborKey,
  removeKey,
  setKey,
  setKeyEase,
  setValueAt,
  shiftKeys,
  toggleAnimation,
} from './keyframes'
import { applyOps } from './ops/applyOps'
import { findClip } from './lookup'
import { clip, sampleProject, seqIds } from './testUtils'

const keys = (...kv: [number, number][]): Keyframe[] => kv.map(([t, v]) => ({ t, v, ease: 'linear' }))

describe('keyframe editing (FRONTEND.md §4.2)', () => {
  it('setKey: constant → first key, replace at the same time, insert sorted with the previous ease', () => {
    expect(setKey(1, 0.5, 2)).toEqual([{ t: 0.5, v: 2, ease: 'linear' }])
    const a = setKey([{ t: 0, v: 1, ease: 'easeOut' }, ...keys([2, 3])], 1, 5)
    expect(a.map((k) => k.t)).toEqual([0, 1, 2])
    expect(a[1]).toEqual({ t: 1, v: 5, ease: 'easeOut' })
    const b = setKey(a, 1.00001, 7)
    expect(b).toHaveLength(3)
    expect(b[1]!.v).toBe(7)
    expect(b[1]!.ease).toBe('easeOut')
  })

  it('removeKey: last key turns the property into a constant', () => {
    const a = keys([0, 1], [1, 3])
    expect(removeKey(a, 0)).toEqual(keys([1, 3]))
    expect(removeKey(keys([1, 3]), 1)).toBe(3)
    expect(removeKey(a, 0.5)).toBe(a)
    expect(removeKey(4, 0)).toBe(4)
  })

  it('setValueAt auto-keys animated properties, toggleAnimation is a stopwatch', () => {
    expect(setValueAt(1, 0.3, 2)).toBe(2)
    expect(setValueAt(keys([0, 1]), 0.3, 2)).toEqual(keys([0, 1], [0.3, 2]))
    expect(toggleAnimation(1.5, 0.2)).toEqual([{ t: 0.2, v: 1.5, ease: 'linear' }])
    expect(toggleAnimation(keys([0, 0], [1, 10]), 0.5)).toBe(5)
  })

  it('setKeyEase changes interpolation of the key to the next one', () => {
    const a = setKeyEase(keys([0, 0], [1, 10]), 0, 'hold')
    expect(evaluateAnimatable(a, 0.9)).toBe(0)
    expect(evaluateAnimatable(a, 1)).toBe(10)
  })

  it('shiftKeys moves within [0, max] and replaces a key it lands on', () => {
    const a = keys([0, 1], [1, 2], [2, 3])
    expect(shiftKeys(a, [1], 0.5, 4)).toEqual(keys([0, 1], [1.5, 2], [2, 3]))
    expect(shiftKeys(a, [1], 1, 4)).toEqual(keys([0, 1], [2, 2]))
    expect(shiftKeys(a, [2], 5, 2.5)).toEqual(keys([0, 1], [1, 2], [2.5, 3]))
    expect(shiftKeys(a, [0], -1, 4)).toEqual(a)
  })

  it('neighborKey', () => {
    expect(neighborKey([0, 1, 2], 1, 1)).toBe(2)
    expect(neighborKey([0, 1, 2], 1, -1)).toBe(0)
    expect(neighborKey([0, 1, 2], 2, 1)).toBeNull()
  })

  it('animPatch replaces one transform field and keeps the rest', () => {
    const c = clip('clp_x', 0, 2)
    expect(animPatch(c, 'scale', 2)).toEqual({ transform: { ...c.transform, scale: 2 } })
    expect(animPatch(c, 'opacity', 0.5)).toEqual({ opacity: 0.5 })
  })
})

describe('property lanes (clipKeys)', () => {
  const project = () => {
    const p = sampleProject()
    const c = findClip(p, 'clp_a')!.clip
    c.transform.x = keys([0, 0], [1, 0.5])
    c.transform.y = [{ t: 1, v: 0, ease: 'easeIn' }, ...keys([1.5, 0.2])]
    c.transform.scale = keys([0.5, 1], [1.5, 2])
    return p
  }

  it('position lane merges x and y key times; clip diamonds merge all lanes', () => {
    const c = findClip(project(), 'clp_a')!.clip
    expect(laneKeyTimes(c, 'position')).toEqual([0, 1, 1.5])
    expect(laneKeyTimes(c, 'opacity')).toEqual([])
    expect(clipKeyTimes(c)).toEqual([0, 0.5, 1, 1.5])
    expect(laneKeyEase(c, 'position', 1)).toBe('linear') // x — первое поле с ключом
    expect(laneKeyEase(c, 'position', 1.5)).toBe('linear')
  })

  it('shift, ease and remove produce valid updateClip ops (one per clip)', () => {
    const p = project()
    const refs = [{ clipId: 'clp_a', lane: 'position' as const, t: 1 }]
    const shifted = applyOps(p, planShiftKeys(p, refs, 0.25), { newId: seqIds() }).project
    const c1 = findClip(shifted, 'clp_a')!.clip
    expect(laneKeyTimes(c1, 'position')).toEqual([0, 1.25, 1.5])
    expect(c1.transform.scale).toEqual(findClip(p, 'clp_a')!.clip.transform.scale)

    const eased = applyOps(p, planKeysEase(p, refs, 'hold'), { newId: seqIds() }).project
    expect(laneKeyEase(findClip(eased, 'clp_a')!.clip, 'position', 1)).toBe('hold')

    const removed = applyOps(p, planRemoveKeys(p, [...refs, { clipId: 'clp_a', lane: 'scale', t: 0.5 }]), {
      newId: seqIds(),
    }).project
    const c2 = findClip(removed, 'clp_a')!.clip
    expect(laneKeyTimes(c2, 'position')).toEqual([0, 1.5])
    expect(c2.transform.scale).toEqual(keys([1.5, 2]))
    expect(planShiftKeys(p, refs, 0)).toEqual([])
  })
})
