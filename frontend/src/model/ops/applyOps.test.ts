import { describe, expect, it } from 'vitest'
import { fixtures } from '@/api/mocks/fixtures'
import type { Clip, EditOp, EffectItem, Project } from '@/shared/types.gen'
import { checkInvariants } from '../invariants'
import { findClip, findEffect, findMarker, findTrack } from '../lookup'
import { clipFromAsset } from '../project'
import { audioAsset, sampleProject, seqIds, videoAsset } from '../testUtils'
import { applyOps, OpsError } from './applyOps'

const ctx = () => ({
  newId: seqIds(),
  resolveAsset: (id: string) => [videoAsset, audioAsset].find((a) => a.id === id),
})

function run(p: Project, ops: EditOp[]) {
  return applyOps(p, ops, ctx())
}

function expectReject(p: Project, ops: EditOp[], code: string) {
  const before = JSON.stringify(p)
  let err: unknown
  try {
    run(p, ops)
  } catch (e) {
    err = e
  }
  expect(err).toBeInstanceOf(OpsError)
  expect((err as OpsError).code).toBe(code)
  expect(JSON.stringify(p)).toBe(before) // исходный проект не тронут
}

function clipOf(p: Project, id: string): Clip {
  const c = findClip(p, id)
  if (!c) throw new Error(`no clip ${id}`)
  return c.clip
}

const fx = (start = 0): Omit<EffectItem, 'id' | 'type'> => ({
  effect: 'flash',
  start,
  duration: 0.2,
  params: {},
  envelope: { attack: 0, hold: 0, decay: 0.2, curve: 'linear' },
  enabled: true,
})

describe('applyOps', () => {
  it('fixture project satisfies all invariants', () => {
    expect(checkInvariants(fixtures.project)).toEqual([])
  })

  it('addTrack: inserts at index, generates id, maps tmp_ id', () => {
    const p = sampleProject()
    const res = run(p, [
      {
        op: 'addTrack',
        track: { id: 'tmp_t', kind: 'video', name: 'V3', muted: false, locked: false, hidden: false },
        index: 1,
      },
      { op: 'addClip', trackId: 'tmp_t', clip: clipFromAsset(videoAsset, 0, 30) },
    ])
    const realId = res.idMap['tmp_t']!
    expect(realId).toMatch(/^trk_/)
    expect(res.project.tracks[1]!.id).toBe(realId)
    expect(res.project.tracks[1]!.items).toHaveLength(1)
    expect(res.created).toContain(realId)
  })

  it('removeTrack: removes track with items; unknown track rejected', () => {
    const p = sampleProject()
    const res = run(p, [{ op: 'removeTrack', trackId: 'trk_v1' }])
    expect(findTrack(res.project, 'trk_v1')).toBeUndefined()
    expect(findClip(res.project, 'clp_a')).toBeUndefined()
    expectReject(p, [{ op: 'removeTrack', trackId: 'trk_nope' }], 'track_not_found')
  })

  it('updateTrack: patches name/flags/volume; validates values', () => {
    const p = sampleProject()
    const res = run(p, [
      { op: 'updateTrack', trackId: 'trk_v1', patch: { name: 'Main', muted: true, hidden: true } },
      { op: 'updateTrack', trackId: 'trk_a1', patch: { volume: 1.5, locked: true } },
    ])
    expect(findTrack(res.project, 'trk_v1')).toMatchObject({
      name: 'Main',
      muted: true,
      hidden: true,
      locked: false,
    })
    expect(findTrack(res.project, 'trk_a1')).toMatchObject({ volume: 1.5, locked: true })
    // items не затронуты
    expect(findTrack(res.project, 'trk_v1')!.items).toHaveLength(2)
    expectReject(p, [{ op: 'updateTrack', trackId: 'trk_nope', patch: { muted: true } }], 'track_not_found')
    expectReject(p, [{ op: 'updateTrack', trackId: 'trk_v1', patch: { name: '  ' } }], 'bad_value')
    expectReject(p, [{ op: 'updateTrack', trackId: 'trk_a1', patch: { volume: 3 } }], 'bad_value')
    expectReject(p, [{ op: 'updateTrack', trackId: 'trk_v1', patch: { volume: 1 } }], 'bad_value')
  })

  it('updateTrack: tmp_ id of a track created earlier in the same list', () => {
    const p = sampleProject()
    const res = run(p, [
      {
        op: 'addTrack',
        track: {
          id: 'tmp_a',
          kind: 'audio',
          name: 'A2',
          muted: false,
          locked: false,
          hidden: false,
          volume: 1,
        },
      },
      { op: 'updateTrack', trackId: 'tmp_a', patch: { muted: true } },
    ])
    expect(findTrack(res.project, res.idMap['tmp_a']!)!.muted).toBe(true)
  })

  it('moveTrack: index is the final position in project.tracks; clamps past the end', () => {
    const p = sampleProject() // [v1, v2, fx, a1]
    const ids = (q: Project) => q.tracks.map((t) => t.id)
    expect(ids(run(p, [{ op: 'moveTrack', trackId: 'trk_v1', index: 2 }]).project)).toEqual([
      'trk_v2',
      'trk_fx',
      'trk_v1',
      'trk_a1',
    ])
    expect(ids(run(p, [{ op: 'moveTrack', trackId: 'trk_a1', index: 0 }]).project)).toEqual([
      'trk_a1',
      'trk_v1',
      'trk_v2',
      'trk_fx',
    ])
    expect(ids(run(p, [{ op: 'moveTrack', trackId: 'trk_v1', index: 99 }]).project)).toEqual([
      'trk_v2',
      'trk_fx',
      'trk_a1',
      'trk_v1',
    ])
    // на месте — без изменений
    expect(ids(run(p, [{ op: 'moveTrack', trackId: 'trk_fx', index: 2 }]).project)).toEqual(ids(p))
    expectReject(p, [{ op: 'moveTrack', trackId: 'trk_nope', index: 0 }], 'track_not_found')
    expectReject(p, [{ op: 'moveTrack', trackId: 'trk_v1', index: -1 }], 'bad_value')
    expectReject(p, [{ op: 'moveTrack', trackId: 'trk_v1', index: 1.5 }], 'bad_value')
  })

  it('addClip: copies asset metadata from the library into project.assets', () => {
    const p = sampleProject()
    p.assets = []
    p.tracks[0]!.items = []
    const res = run(p, [{ op: 'addClip', trackId: 'trk_v1', clip: clipFromAsset(videoAsset, 1, 30) }])
    expect(res.project.assets.map((a) => a.id)).toEqual([videoAsset.id])
    expect(res.project.tracks[0]!.items[0]!.start).toBe(1)
    expect(res.project.duration).toBe(11)
  })

  it('addClip: rejects overlap, wrong track kind and unknown asset', () => {
    const p = sampleProject()
    expectReject(
      p,
      [{ op: 'addClip', trackId: 'trk_v1', clip: clipFromAsset(videoAsset, 1, 30) }],
      'invariant_violation',
    )
    expectReject(
      p,
      [{ op: 'addClip', trackId: 'trk_a1', clip: clipFromAsset(videoAsset, 0, 30) }],
      'incompatible_track',
    )
    expectReject(
      p,
      [
        {
          op: 'addClip',
          trackId: 'trk_v2',
          clip: { ...clipFromAsset(videoAsset, 0, 30), assetId: 'ast_missing' },
        },
      ],
      'asset_not_found',
    )
  })

  it('updateClip: patches fields and keeps invariant 4', () => {
    const p = sampleProject()
    const res = run(p, [{ op: 'updateClip', clipId: 'clp_b', patch: { label: 'hi', color: '#ff0000' } }])
    expect(clipOf(res.project, 'clp_b')).toMatchObject({ label: 'hi', color: '#ff0000' })
    expectReject(p, [{ op: 'updateClip', clipId: 'clp_b', patch: { speed: 2 } }], 'invariant_violation')
    expectReject(p, [{ op: 'updateClip', clipId: 'clp_x', patch: {} }], 'clip_not_found')
  })

  it('moveClip: moves within and across tracks of the same kind, keeps items sorted', () => {
    const p = sampleProject()
    const res = run(p, [
      { op: 'moveClip', clipId: 'clp_a', start: 5 },
      { op: 'moveClip', clipId: 'clp_b', start: 1, trackId: 'trk_v2' },
    ])
    expect(findTrack(res.project, 'trk_v1')!.items.map((i) => i.id)).toEqual(['clp_a'])
    expect(findTrack(res.project, 'trk_v2')!.items.map((i) => [i.id, i.start])).toEqual([['clp_b', 1]])
    expectReject(p, [{ op: 'moveClip', clipId: 'clp_a', start: 0, trackId: 'trk_a1' }], 'incompatible_track')
    expectReject(p, [{ op: 'moveClip', clipId: 'clp_a', start: 1 }], 'invariant_violation')
  })

  it('splitClip: two halves with contiguous source ranges', () => {
    const p = sampleProject()
    const res = run(p, [{ op: 'splitClip', clipId: 'clp_b', at: 3 }])
    const items = findTrack(res.project, 'trk_v1')!.items as Clip[]
    expect(items.map((c) => [c.start, c.duration, c.sourceIn, c.sourceOut])).toEqual([
      [0, 2, 0, 2],
      [2, 1, 3, 4],
      [3, 1, 4, 5],
    ])
    expect(items[2]!.id).toMatch(/^clp_/)
    expectReject(p, [{ op: 'splitClip', clipId: 'clp_b', at: 2 }], 'split_out_of_range')
  })

  it('splitClip: reverse clip — left half takes the end of the source range', () => {
    const p = sampleProject()
    const b = p.tracks[0]!.items[1] as Clip
    b.reverse = true
    b.speed = 2
    b.sourceIn = 1
    b.sourceOut = 5 // duration 2 = 4 / 2
    b.markers = [
      { id: 'mrk_early', t: 1.5, kind: 'beat', strength: 1 },
      { id: 'mrk_late', t: 4.5, kind: 'beat', strength: 1 },
    ]
    const res = run(p, [{ op: 'splitClip', clipId: 'clp_b', at: 2.5 }])
    const [, left, right] = findTrack(res.project, 'trk_v1')!.items as Clip[]
    expect([left!.sourceIn, left!.sourceOut, left!.duration]).toEqual([4, 5, 0.5])
    expect([right!.sourceIn, right!.sourceOut, right!.duration]).toEqual([1, 4, 1.5])
    expect(left!.markers.map((m) => m.id)).toEqual(['mrk_late'])
    expect(right!.markers.map((m) => m.id)).toEqual(['mrk_early'])
  })

  it('splitClip: time-remapped clip keeps exact source continuity', () => {
    const remapClip = fixtures.project.tracks[0]!.items.find((i) => i.id === 'clp_drop000002') as Clip
    const res = run(fixtures.project, [{ op: 'splitClip', clipId: remapClip.id, at: remapClip.start + 0.3 }])
    const left = clipOf(res.project, remapClip.id)
    const right = res.project.tracks[0]!.items.find((i) => i.start === left.start + left.duration) as Clip
    expect(left.sourceOut).toBeCloseTo(right.sourceIn, 9)
    expect(left.sourceIn).toBe(remapClip.sourceIn)
    expect(right.sourceOut).toBeCloseTo(remapClip.sourceOut, 9)
    expect(left.timeRemap!.keyframes[0]!.u).toBe(0)
    expect(right.timeRemap!.keyframes.at(-1)!.u).toBe(1)
  })

  it('removeClip: plain and ripple', () => {
    const p = sampleProject()
    const plain = run(p, [{ op: 'removeClip', clipId: 'clp_a' }])
    expect(clipOf(plain.project, 'clp_b').start).toBe(2)
    const ripple = run(p, [{ op: 'removeClip', clipId: 'clp_a', ripple: true }])
    expect(clipOf(ripple.project, 'clp_b').start).toBe(0)
  })

  it('setTimeRemap: sets free curve (computes sourceOut) and clears back to constant speed', () => {
    const p = sampleProject()
    const set = run(p, [
      {
        op: 'setTimeRemap',
        clipId: 'clp_a',
        timeRemap: {
          keyframes: [
            { u: 0, speed: 1, ease: 'linear' },
            { u: 1, speed: 1, ease: 'linear' },
          ],
          fit: 'free',
          frameBlend: false,
        },
      },
    ])
    expect(clipOf(set.project, 'clp_a').sourceOut).toBeCloseTo(2, 9)
    const cleared = applyOps(set.project, [{ op: 'setTimeRemap', clipId: 'clp_a', timeRemap: null }], ctx())
    const c = clipOf(cleared.project, 'clp_a')
    expect(c.timeRemap).toBeUndefined()
    expect(c.speed).toBeCloseTo(1, 9)
    expectReject(
      p,
      [
        {
          op: 'setTimeRemap',
          clipId: 'clp_a',
          timeRemap: { keyframes: [{ u: 0, speed: 1, ease: 'linear' }], fit: 'free', frameBlend: false },
        },
      ],
      'bad_time_remap',
    )
  })

  it('addMarkers: to project and to clip, sorted by t', () => {
    const p = sampleProject()
    const res = run(p, [
      {
        op: 'addMarkers',
        target: 'project',
        markers: [
          { t: 3, kind: 'manual', strength: 1 },
          { t: 1, kind: 'manual', strength: 1 },
        ],
      },
      {
        op: 'addMarkers',
        target: { clipId: 'clp_a' },
        markers: [{ id: 'tmp_m', t: 0.5, kind: 'bass', strength: 0.7 }],
      },
    ])
    expect(res.project.markers.map((m) => m.t)).toEqual([1, 3])
    expect(clipOf(res.project, 'clp_a').markers[0]!.id).toBe(res.idMap['tmp_m'])
    expectReject(
      p,
      [{ op: 'addMarkers', target: 'project', markers: [{ t: 1, kind: 'manual', strength: 3 }] }],
      'bad_value',
    )
  })

  it('updateMarker / removeMarkers: removing a marker drops anchors (invariant 6)', () => {
    const p = sampleProject()
    const res = run(p, [
      { op: 'addMarkers', target: 'project', markers: [{ id: 'tmp_m', t: 1, kind: 'manual', strength: 1 }] },
      {
        op: 'addEffect',
        target: { trackId: 'trk_fx' },
        effect: { ...fx(3), anchor: { markerId: 'tmp_m', offset: 0 } },
      },
      { op: 'updateMarker', markerId: 'tmp_m', patch: { label: 'drop' } },
    ])
    const markerId = res.idMap['tmp_m']!
    expect(findMarker(res.project, markerId)!.marker.label).toBe('drop')
    const removed = applyOps(res.project, [{ op: 'removeMarkers', markerIds: [markerId] }], ctx())
    expect(removed.project.markers).toEqual([])
    const effect = findTrack(removed.project, 'trk_fx')!.items[1] as EffectItem
    expect(effect.anchor).toBeUndefined()
    expect(effect.start).toBe(3)
    expectReject(p, [{ op: 'removeMarkers', markerIds: ['mrk_nope'] }], 'marker_not_found')
  })

  it('addEffect / updateEffect / removeEffect on fx track and on clip', () => {
    const p = sampleProject()
    const res = run(p, [
      { op: 'addEffect', target: { clipId: 'clp_a' }, effect: { ...fx(0), id: 'tmp_e' } },
      { op: 'updateEffect', effectId: 'tmp_e', patch: { duration: 0.4 } },
      { op: 'updateEffect', effectId: 'fx_shake', patch: { start: 2 } },
    ])
    const id = res.idMap['tmp_e']!
    expect(findEffect(res.project, id)!.effect.duration).toBe(0.4)
    expect(findEffect(res.project, 'fx_shake')!.effect.start).toBe(2)
    const removed = applyOps(res.project, [{ op: 'removeEffect', effectId: id }], ctx())
    expect(findEffect(removed.project, id)).toBeUndefined()
    expectReject(p, [{ op: 'addEffect', target: { trackId: 'trk_v1' }, effect: fx() }], 'incompatible_track')
    expectReject(
      p,
      [{ op: 'addEffect', target: { trackId: 'trk_fx' }, effect: { ...fx(), effect: 'nope' } }],
      'unknown_effect',
    )
  })

  it('is atomic: a failing op rolls back the whole list', () => {
    const p = sampleProject()
    expectReject(
      p,
      [
        { op: 'moveClip', clipId: 'clp_b', start: 6 },
        { op: 'removeClip', clipId: 'clp_missing' },
      ],
      'clip_not_found',
    )
  })

  it('rejects unknown ops, macro ops (not yet) and unresolved temp ids', () => {
    const p = sampleProject()
    expectReject(p, [{ op: 'explode' } as unknown as EditOp], 'unknown_op')
    expectReject(
      p,
      [{ op: 'cutToMarkers', clipIds: ['clp_a'], filter: {}, order: 'sequential' }],
      'not_implemented',
    )
    expectReject(p, [{ op: 'moveClip', clipId: 'tmp_x', start: 0 }], 'unknown_temp_id')
  })

  it('rejects duplicate explicit ids', () => {
    const p = sampleProject()
    expectReject(
      p,
      [{ op: 'addClip', trackId: 'trk_v2', clip: { ...clipFromAsset(videoAsset, 0, 30), id: 'clp_a' } }],
      'duplicate_id',
    )
  })
})
