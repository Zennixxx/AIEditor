import { describe, expect, it } from 'vitest'
import type { Clip, EditOp, EffectItem, MarkerInput, Project } from '@/shared/types.gen'
import { checkInvariants } from './invariants'
import { findTrack } from './lookup'
import { applyOps, OpsError } from './ops/applyOps'
import { clip, musicProject, seqIds } from './testUtils'

const apply = (p: Project, ops: EditOp[]) => applyOps(p, ops, { newId: seqIds() })

/** Музыка на таймлайне с 10 с (source 20); bass каждые 0.5 с, сила чередуется 1 / 0.5. */
function project(markers?: MarkerInput[]): Project {
  const list: MarkerInput[] =
    markers ??
    Array.from({ length: 6 }, (_, i) => ({ t: 20 + i * 0.5, kind: 'bass', strength: i % 2 ? 0.5 : 1 }))
  const p = apply(musicProject(), [
    { op: 'addMarkers', target: { clipId: 'clp_music' }, markers: list },
  ]).project
  return p
}

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn()
  } catch (e) {
    expect(e).toBeInstanceOf(OpsError)
    expect((e as OpsError).code).toBe(code)
    return
  }
  throw new Error(`expected ${code}`)
}

const fxOf = (p: Project, trackId: string) => findTrack(p, trackId)!.items as EffectItem[]

describe('applyEffectToMarkers', () => {
  it('newFxTrack: one effect per marker on a new top fx track', () => {
    const p = project()
    const res = apply(p, [{ op: 'applyEffectToMarkers', effect: 'shake', filter: {}, target: 'newFxTrack' }])
    const top = res.project.tracks[res.project.tracks.length - 1]!
    expect(top.kind).toBe('fx')
    expect(top.name).toBe('FX: Шейк')
    const items = top.items as EffectItem[]
    expect(items.map((e) => e.start)).toEqual([10, 10.5, 11, 11.5, 12, 12.5])
    // defaultDuration 0.35 < шаг 0.5 — не обрезается
    expect(items.every((e) => e.duration === 0.35)).toBe(true)
    expect(items[0]!.envelope).toEqual({ attack: 0, hold: 0.05, decay: 0.3, curve: 'exp' })
    expect(items[0]!.params).toEqual({})
    expect(items[0]!.anchor).toEqual({
      markerId: expect.stringMatching(/^mrk_/),
      clipId: 'clp_music',
      offset: 0,
    })
    expect(items.every((e) => e.enabled)).toBe(true)
    expect(checkInvariants(res.project)).toEqual([])
  })

  it('truncates duration to the next marker and keeps the last one full', () => {
    const p = project()
    const res = apply(p, [
      { op: 'applyEffectToMarkers', effect: 'shake', duration: 0.8, filter: {}, target: 'newFxTrack' },
    ])
    const items = res.project.tracks.at(-1)!.items
    expect(items.slice(0, -1).every((e) => Math.abs(e.duration - 0.5) < 1e-9)).toBe(true)
    expect(items.at(-1)!.duration).toBe(0.8)
  })

  it('filter + scaleByStrength + params/envelope overrides', () => {
    const p = project()
    const res = apply(p, [
      {
        op: 'applyEffectToMarkers',
        effect: 'shake',
        params: { amount: 60, strength: 1.5 },
        envelope: { decay: 0.2 },
        scaleByStrength: true,
        filter: { every: 2, offset: 1 },
        target: 'newFxTrack',
      },
    ])
    const items = res.project.tracks.at(-1)!.items as EffectItem[]
    expect(items.map((e) => e.start)).toEqual([10.5, 11.5, 12.5])
    expect(items.map((e) => e.params)).toEqual([0, 1, 2].map(() => ({ amount: 60, strength: 0.75 })))
    expect(items[0]!.envelope).toEqual({ attack: 0, hold: 0.05, decay: 0.2, curve: 'exp' })
  })

  it('scaleByStrength clamps to the registry range and is ignored for transitions', () => {
    const p = project([{ t: 20, kind: 'bass', strength: 1 }])
    const res = apply(p, [
      {
        op: 'applyEffectToMarkers',
        effect: 'flash',
        scaleByStrength: true,
        params: { strength: 2 },
        filter: {},
        target: 'newFxTrack',
      },
      {
        op: 'applyEffectToMarkers',
        effect: 'whipPan',
        scaleByStrength: true,
        filter: {},
        target: 'newFxTrack',
      },
    ])
    const tracks = res.project.tracks
    expect((tracks.at(-2)!.items[0] as EffectItem).params).toEqual({ strength: 2 })
    expect((tracks.at(-1)!.items[0] as EffectItem).params).toEqual({})
  })

  it('existing fx track: places effects, rejects overlap and non-fx tracks', () => {
    const p = project()
    const res = apply(p, [
      {
        op: 'applyEffectToMarkers',
        effect: 'flicker',
        filter: { range: { start: 11, end: 12 } },
        target: { trackId: 'trk_fx' },
      },
    ])
    expect(fxOf(res.project, 'trk_fx').map((e) => e.start)).toEqual([1, 11, 11.5, 12])
    expectCode(
      () =>
        apply(res.project, [
          { op: 'applyEffectToMarkers', effect: 'shake', filter: {}, target: { trackId: 'trk_fx' } },
        ]),
      'slots_overlap',
    )
    expectCode(
      () =>
        apply(p, [
          { op: 'applyEffectToMarkers', effect: 'shake', filter: {}, target: { trackId: 'trk_v1' } },
        ]),
      'incompatible_track',
    )
    expectCode(
      () =>
        apply(p, [
          { op: 'applyEffectToMarkers', effect: 'shake', filter: {}, target: { trackId: 'trk_nope' } },
        ]),
      'track_not_found',
    )
  })

  it('clipsUnderMarker: effect into every video clip under the marker, clipped to the clip end', () => {
    const p = structuredClone(project())
    const v1 = findTrack(p, 'trk_v1')!
    v1.items.push(clip('clp_c', 10, 1.2) as Clip)
    findTrack(p, 'trk_v2')!.items.push(clip('clp_d', 11, 4) as Clip)
    const res = apply(p, [
      { op: 'applyEffectToMarkers', effect: 'zoomPunch', filter: {}, target: 'clipsUnderMarker' },
    ])
    const c = (findTrack(res.project, 'trk_v1')!.items.find((i) => i.id === 'clp_c') as Clip).effects
    expect(c.map((e) => [e.start, e.duration])).toEqual([
      [0, 0.3],
      [0.5, 0.3],
      [1, expect.closeTo(0.2, 9)],
    ])
    const d = (findTrack(res.project, 'trk_v2')!.items[0] as Clip).effects
    expect(d.map((e) => e.start)).toEqual([0, 0.5, 1, 1.5])
    expect(checkInvariants(res.project)).toEqual([])
  })

  it('one undoable transaction: errors reject everything', () => {
    const p = project()
    expectCode(
      () =>
        apply(p, [
          { op: 'applyEffectToMarkers', effect: 'shake', filter: {}, target: 'newFxTrack' },
          { op: 'applyEffectToMarkers', effect: 'nope', filter: {}, target: 'newFxTrack' },
        ]),
      'unknown_effect',
    )
  })

  it('validates params, duration and empty results', () => {
    const p = project()
    const base = { op: 'applyEffectToMarkers', effect: 'shake', filter: {}, target: 'newFxTrack' } as const
    expectCode(() => apply(p, [{ ...base, params: { amount: 1000 } }]), 'bad_value')
    expectCode(() => apply(p, [{ ...base, params: { wobble: 1 } }]), 'bad_value')
    expectCode(() => apply(p, [{ ...base, duration: 0 }]), 'bad_value')
    expectCode(() => apply(p, [{ ...base, filter: { kinds: ['downbeat'] } }]), 'no_markers')
    expectCode(() => apply(p, [{ ...base, target: 'clipsUnderMarker' }]), 'no_markers')
  })

  it('drops markers closer than a frame', () => {
    const p = project([
      { t: 20, kind: 'bass', strength: 1 },
      { t: 20.01, kind: 'bass', strength: 1 },
      { t: 20.5, kind: 'bass', strength: 1 },
    ])
    const res = apply(p, [{ op: 'applyEffectToMarkers', effect: 'shake', filter: {}, target: 'newFxTrack' }])
    expect(res.project.tracks.at(-1)!.items.map((e) => e.start)).toEqual([10, 10.5])
  })
})

describe('anchored effects follow markers (CONTRACT §2)', () => {
  const setup = () => {
    const p = project()
    const res = apply(p, [{ op: 'applyEffectToMarkers', effect: 'shake', filter: {}, target: 'newFxTrack' }])
    const fx = res.project.tracks.at(-1)!.items as EffectItem[]
    return { p: res.project, fx }
  }

  it('moving the marker moves the effect', () => {
    const { p, fx } = setup()
    const first = fx[0]!
    const res = apply(p, [{ op: 'updateMarker', markerId: first.anchor!.markerId, patch: { t: 20.2 } }])
    const moved = fxOf(res.project, res.project.tracks.at(-1)!.id).find((e) => e.id === first.id)!
    expect(moved.start).toBeCloseTo(10.2)
  })

  it('moving the music clip moves all anchored effects', () => {
    const { p, fx } = setup()
    const res = apply(p, [{ op: 'moveClip', clipId: 'clp_music', start: 12 }])
    expect(res.project.tracks.at(-1)!.items.map((e) => e.start)).toEqual(fx.map((e) => e.start + 2))
  })

  it('moving the effect itself keeps its place and updates the offset', () => {
    const { p, fx } = setup()
    const first = fx[0]!
    const res = apply(p, [{ op: 'updateEffect', effectId: first.id, patch: { start: 10.1 } }])
    const e = res.project.tracks.at(-1)!.items.find((i) => i.id === first.id) as EffectItem
    expect(e.start).toBeCloseTo(10.1)
    expect(e.anchor!.offset).toBeCloseTo(0.1)
    // дальше эффект едет с маркером, сохраняя сдвиг
    const res2 = apply(res.project, [{ op: 'moveClip', clipId: 'clp_music', start: 11 }])
    expect(res2.project.tracks.at(-1)!.items.find((i) => i.id === first.id)!.start).toBeCloseTo(11.1)
  })

  it('removing the marker drops the anchor and leaves the effect in place', () => {
    const { p, fx } = setup()
    const first = fx[0]!
    const res = apply(p, [{ op: 'removeMarkers', markerIds: [first.anchor!.markerId] }])
    const e = res.project.tracks.at(-1)!.items.find((i) => i.id === first.id) as EffectItem
    expect(e.anchor).toBeUndefined()
    expect(e.start).toBe(10)
  })
})
