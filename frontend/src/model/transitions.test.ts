import { describe, expect, it } from 'vitest'
import { findTrack } from './lookup'
import { applyOps } from './ops/applyOps'
import { clip, sampleProject, seqIds, track } from './testUtils'
import { findCuts, nearestCut, planTransitions, transitionSpan } from './transitions'
import type { EffectItem, Project } from '@/shared/types.gen'

/** V1: [0..2) [2..4) [4..5) + V1 с пробелом перед [6..7). */
function cutsProject(): Project {
  const p = sampleProject()
  findTrack(p, 'trk_v1')!.items.push(clip('clp_c', 4, 1), clip('clp_d', 6, 1))
  return p
}

describe('transitions (FRONTEND.md §4.2)', () => {
  it('findCuts: adjacent clips only, filtered by selected clips', () => {
    const p = cutsProject()
    expect(findCuts(p).map((c) => [c.t, c.leftId, c.rightId])).toEqual([
      [2, 'clp_a', 'clp_b'],
      [4, 'clp_b', 'clp_c'],
    ])
    expect(findCuts(p, new Set(['clp_c'])).map((c) => c.t)).toEqual([4])
    expect(findCuts(p, new Set(['clp_d']))).toEqual([])
  })

  it('nearestCut respects the distance limit', () => {
    const p = cutsProject()
    expect(nearestCut(p, 3.2, 1)?.t).toBe(4)
    expect(nearestCut(p, 3, 0.5)).toBeNull()
    expect(nearestCut(p, 3, 2, 'trk_v2')?.t).toBe(2) // на V2 стыков нет — ищем на всех
  })

  it('span is centred on the cut and not longer than either neighbour', () => {
    const [, second] = findCuts(cutsProject())
    expect(transitionSpan(second!, 0.4)).toEqual({ start: 3.8, duration: 0.4 })
    expect(transitionSpan(second!, 3).duration).toBe(1) // правый клип 1 с
  })

  it('new "Переходы" fx track right above the video track; reused next time', () => {
    const p = cutsProject()
    const plan = planTransitions(p, 'whipPan', findCuts(p))
    expect(plan.targets[0]!.fxTrackId).toBeNull()
    const res = applyOps(p, plan.ops, { newId: seqIds() })
    const fx = res.project.tracks[1]!
    expect(fx.kind).toBe('fx')
    expect(fx.name).toBe('Переходы')
    const items = fx.items as EffectItem[]
    expect(items.map((i) => [i.effect, i.start, i.duration])).toEqual([
      ['whipPan', 1.85, 0.3],
      ['whipPan', 3.85, 0.3],
    ])

    // повторно: та же дорожка, если место свободно
    const q = structuredClone(res.project)
    findTrack(q, 'trk_v1')!.items.push(clip('clp_e', 7, 1))
    const again = planTransitions(q, 'flashTransition', findCuts(q, new Set(['clp_e'])))
    expect(again.targets[0]!.fxTrackId).toBe(fx.id)
    expect(again.ops.every((o) => o.op === 'addEffect')).toBe(true)
  })

  it('a non-transition fx track above is not reused', () => {
    const p = cutsProject()
    p.tracks.splice(1, 0, track('trk_fxshake', 'fx'))
    findTrack(p, 'trk_fxshake')!.items.push({
      id: 'fx_s1',
      type: 'effect',
      effect: 'shake',
      start: 0,
      duration: 0.2,
      params: {},
      envelope: { attack: 0, hold: 0, decay: 0.2, curve: 'linear' },
      enabled: true,
    })
    const plan = planTransitions(p, 'whipPan', findCuts(p))
    expect(plan.targets[0]!.fxTrackId).toBeNull()
    const res = applyOps(p, plan.ops, { newId: seqIds() })
    expect(res.project.tracks[1]!.name).toBe('Переходы')
  })

  it('errors: not a transition, no cuts', () => {
    const p = cutsProject()
    expect(() => planTransitions(p, 'shake', findCuts(p))).toThrow(/не переход/)
    expect(() => planTransitions(p, 'whipPan', [])).toThrow(/Нет стыков/)
  })
})
