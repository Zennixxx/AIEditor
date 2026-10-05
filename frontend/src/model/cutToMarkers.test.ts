import { describe, expect, it } from 'vitest'
import type { Clip, ClipAnalysis, EditOp, MarkerInput, Project } from '@/shared/types.gen'
import { countSlots, expandCutToMarkers, mulberry32, slotsFromTimes, type CutOp } from './cutToMarkers'
import { checkInvariants } from './invariants'
import { findClip, findTrack } from './lookup'
import { filterMarkers, resolveMusicClip } from './markerFilter'
import { applyOps, OpsError } from './ops/applyOps'
import { musicProject, seqIds, videoAsset } from './testUtils'

const apply = (p: Project, ops: EditOp[], clipAnalysis?: (id: string) => ClipAnalysis | undefined) =>
  applyOps(p, ops, { newId: seqIds(), ...(clipAnalysis ? { clipAnalysis } : {}) })

/** Маркеры музыки: bass каждые 0.5 с начиная с timeline 10 (source 20), сила чередуется 1 / 0.5. */
function bassMarkers(count: number, extra: MarkerInput[] = []): MarkerInput[] {
  const res: MarkerInput[] = []
  for (let i = 0; i < count; i++) res.push({ t: 20 + i * 0.5, kind: 'bass', strength: i % 2 === 0 ? 1 : 0.5 })
  return [...res, ...extra]
}

function project(markers: MarkerInput[] = bassMarkers(9)): Project {
  return applyOps(musicProject(), [{ op: 'addMarkers', target: { clipId: 'clp_music' }, markers }], {
    newId: seqIds(),
  }).project
}

const cut = (extra: Partial<CutOp> = {}): CutOp => ({
  op: 'cutToMarkers',
  clipIds: ['clp_a', 'clp_b'],
  filter: {},
  order: 'sequential',
  ...extra,
})

function v1(p: Project): Clip[] {
  return findTrack(p, 'trk_v1')!.items as Clip[]
}

describe('slotsFromTimes', () => {
  it('builds N−1 slots between sorted times', () => {
    expect(slotsFromTimes([3, 1, 2], 0.1)).toEqual([
      { start: 1, end: 2 },
      { start: 2, end: 3 },
    ])
    expect(slotsFromTimes([1], 0.1)).toEqual([])
    expect(slotsFromTimes([], 0.1)).toEqual([])
  })

  it('drops markers closer than one frame to the previous kept one', () => {
    expect(slotsFromTimes([1, 1.01, 1.5, 1.52, 2], 1 / 30)).toEqual([
      { start: 1, end: 1.5 },
      { start: 1.5, end: 2 },
    ])
  })
})

describe('mulberry32', () => {
  it('is deterministic per seed', () => {
    const a = mulberry32(5)
    const b = mulberry32(5)
    const xs = [a(), a(), a()]
    expect(xs).toEqual([b(), b(), b()])
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true)
    expect(mulberry32(6)()).not.toBe(xs[0])
  })
})

describe('filterMarkers', () => {
  it('uses bass of the first audio clip with markers by default, in timeline time', () => {
    const p = project(bassMarkers(4, [{ t: 20.25, kind: 'beat', strength: 1 }]))
    expect(resolveMusicClip(p)?.id).toBe('clp_music')
    expect(filterMarkers(p).map((m) => m.t)).toEqual([10, 10.5, 11, 11.5])
  })

  it('applies kinds, minStrength, range, then every/offset on what is left', () => {
    const p = project()
    expect(filterMarkers(p, { minStrength: 0.8 }).map((m) => m.t)).toEqual([10, 11, 12, 13, 14])
    expect(filterMarkers(p, { every: 2 }).map((m) => m.t)).toEqual([10, 11, 12, 13, 14])
    expect(filterMarkers(p, { every: 2, offset: 1 }).map((m) => m.t)).toEqual([10.5, 11.5, 12.5, 13.5])
    expect(filterMarkers(p, { range: { start: 11, end: 12.5 } }).map((m) => m.t)).toEqual([
      11, 11.5, 12, 12.5,
    ])
    expect(filterMarkers(p, { kinds: ['beat'] })).toEqual([])
  })

  it('follows the clip: a moved clip shifts markers, trimmed-off ones are dropped', () => {
    let p = project()
    p = apply(p, [{ op: 'moveClip', clipId: 'clp_music', start: 20 }]).project
    expect(filterMarkers(p)[0]!.t).toBe(20)
    p = apply(p, [
      { op: 'updateClip', clipId: 'clp_music', patch: { sourceIn: 22, sourceOut: 50, duration: 28 } },
    ]).project
    const ts = filterMarkers(p).map((m) => m.t)
    expect(ts[0]).toBeCloseTo(20, 9) // маркер на source 22 → начало клипа
    expect(ts).toHaveLength(5) // source 22, 22.5, 23, 23.5, 24
  })

  it('filters by section labels (clip sections + project sections)', () => {
    let p = project()
    p = apply(p, [
      {
        op: 'setSections',
        target: { clipId: 'clp_music' },
        sections: [
          { start: 20, end: 22, label: 'intro', energy: 0.2 },
          { start: 22, end: 24.2, label: 'drop', energy: 1 },
        ],
      },
    ]).project
    expect(filterMarkers(p, { sectionLabels: ['drop'] }).map((m) => m.t)).toEqual([12, 12.5, 13, 13.5, 14])
    expect(filterMarkers(p, { sectionLabels: ['intro', 'drop'] })).toHaveLength(9)
    expect(filterMarkers(p, { sectionLabels: ['break'] })).toEqual([])
  })

  it('falls back to project markers without a music clip; rejects bad values', () => {
    let p = project()
    p = apply(p, [{ op: 'removeClip', clipId: 'clp_music' }]).project
    p = apply(p, [
      {
        op: 'addMarkers',
        target: 'project',
        markers: [
          { t: 1, kind: 'bass', strength: 1 },
          { t: 2, kind: 'manual', strength: 1 },
        ],
      },
    ]).project
    expect(resolveMusicClip(p)).toBeNull()
    expect(filterMarkers(p).map((m) => m.t)).toEqual([1])
    expect(() => filterMarkers(p, { every: 0 })).toThrow(OpsError)
    expect(() => filterMarkers(p, { offset: -1 })).toThrow(OpsError)
    expect(() => filterMarkers(p, { every: 1.5 })).toThrow(OpsError)
    expect(() => filterMarkers(p, { minStrength: 2 })).toThrow(OpsError)
    expect(() => filterMarkers(p, { musicClipId: 'clp_nope' })).toThrow(OpsError)
  })
})

describe('cutToMarkers — sequential', () => {
  it('lays clips on slots with joins exactly at the markers, no gaps and no overlaps', () => {
    const p = project(bassMarkers(5)) // маркеры 10, 10.5, 11, 11.5, 12 → 4 слота
    const { project: next } = apply(p, [cut()])
    const clips = v1(next)
    expect(clips.map((c) => c.start)).toEqual([10, 10.5, 11, 11.5])
    clips.forEach((c, i) => {
      expect(c.duration).toBeCloseTo(0.5, 12)
      if (i > 0) expect(clips[i - 1]!.start + clips[i - 1]!.duration).toBeCloseTo(c.start, 12)
    })
    expect(clips[3]!.start + clips[3]!.duration).toBeCloseTo(12, 12)
    expect(checkInvariants(next)).toEqual([])
    // исходные клипы заменены
    expect(findClip(next, 'clp_a')).toBeUndefined()
    expect(findClip(next, 'clp_b')).toBeUndefined()
  })

  it('takes the next piece of the source: clp_a (0..2) then clp_b (3..5)', () => {
    const p = project(bassMarkers(7)) // 6 слотов по 0.5 с: 4 куска из clp_a (0..2), 2 из clp_b (3..4)
    const clips = v1(apply(p, [cut()]).project)
    expect(clips.map((c) => [c.sourceIn, c.sourceOut])).toEqual([
      [0, 0.5],
      [0.5, 1],
      [1, 1.5],
      [1.5, 2],
      [3, 3.5],
      [3.5, 4],
    ])
    expect(clips.every((c) => c.speed === 1 && !c.reverse && c.effects.length === 0)).toBe(true)
  })

  it('wraps around to the first clip when the footage runs out', () => {
    // материал: 2 + 2 с = 8 слотов по 0.5 с; девятый слот — снова clp_a
    const p = project([...bassMarkers(9), { t: 24.5, kind: 'bass', strength: 1 }])
    const clips = v1(apply(p, [cut()]).project)
    expect(clips).toHaveLength(9)
    expect([clips[8]!.sourceIn, clips[8]!.sourceOut]).toEqual([0, 0.5])
  })

  it('works with the filter: every 2nd bass → 1 s slots', () => {
    const p = project(bassMarkers(9))
    const clips = v1(apply(p, [cut({ filter: { every: 2 } })]).project)
    expect(clips.map((c) => c.start)).toEqual([10, 11, 12, 13])
    expect(clips.map((c) => c.duration)).toEqual([1, 1, 1, 1])
  })

  it('stretches a piece with slow motion when the source is shorter than the slot', () => {
    const p = project(bassMarkers(2)) // один слот 0.5 с
    const shortOnly = apply(p, [
      { op: 'updateClip', clipId: 'clp_a', patch: { duration: 0.25, sourceOut: 0.25 } },
      { op: 'removeClip', clipId: 'clp_b' },
    ]).project
    const clips = v1(apply(shortOnly, [cut({ clipIds: ['clp_a'] })]).project)
    expect(clips).toHaveLength(1)
    expect(clips[0]!.speed).toBeCloseTo(0.5, 9) // 0.25 с исходника на 0.5 с таймлайна
    expect([clips[0]!.sourceIn, clips[0]!.sourceOut]).toEqual([0, 0.25])
  })

  it('puts clips on the requested track', () => {
    const p = project(bassMarkers(3))
    const { project: next } = apply(p, [cut({ trackId: 'trk_v2' })])
    expect(findTrack(next, 'trk_v2')!.items).toHaveLength(2)
    expect(v1(next)).toEqual([])
  })

  it('is one atomic transaction with other ops of the list and keeps the music clip intact', () => {
    const p = project(bassMarkers(3))
    const { project: next } = apply(p, [
      cut(),
      { op: 'updateTrack', trackId: 'trk_v1', patch: { name: 'Edit' } },
    ])
    expect(findTrack(next, 'trk_v1')!.name).toBe('Edit')
    expect(findClip(next, 'clp_music')!.clip.markers).toHaveLength(3)
  })
})

describe('cutToMarkers — random', () => {
  const p = project(bassMarkers(9))

  it('is deterministic for a seed and differs between seeds', () => {
    const a = v1(apply(p, [cut({ order: 'random', seed: 7 })]).project)
    const b = v1(apply(p, [cut({ order: 'random', seed: 7 })]).project)
    const c = v1(apply(p, [cut({ order: 'random', seed: 8 })]).project)
    const key = (cs: Clip[]) => cs.map((x) => [x.sourceIn, x.sourceOut])
    expect(key(a)).toEqual(key(b))
    expect(key(a)).not.toEqual(key(c))
  })

  it('stays inside the sources, in the right slots, with valid invariants', () => {
    for (const seed of [1, 2, 3, 99]) {
      const { project: next } = apply(p, [cut({ order: 'random', seed })])
      const clips = v1(next)
      expect(clips).toHaveLength(8)
      expect(clips.map((c) => c.start)).toEqual([10, 10.5, 11, 11.5, 12, 12.5, 13, 13.5])
      for (const c of clips) {
        const inA = c.sourceIn >= 0 && c.sourceOut <= 2 + 1e-9
        const inB = c.sourceIn >= 3 - 1e-9 && c.sourceOut <= 5 + 1e-9
        expect(inA || inB).toBe(true)
      }
      expect(checkInvariants(next)).toEqual([])
    }
  })
})

describe('cutToMarkers — bestMoments', () => {
  const analysis: ClipAnalysis = {
    assetId: videoAsset.id,
    model: 'test',
    summary: '',
    moments: [
      { start: 4, end: 4.4, score: 0.4, tags: [], description: '' },
      { start: 8, end: 9, score: 0.9, tags: [], description: '' },
      { start: 1, end: 1.2, score: 0.7, tags: [], description: '' },
    ],
    shots: [],
    motion: { interval: 0.1, values: [] },
  }

  it('uses the highest-scored moments inside the source ranges first', () => {
    // источники: clp_a 0..2 и clp_b 3..5; в диапазон попадают моменты [1,1.2] (0.7) и [4,4.4] (0.4)
    const p = project(bassMarkers(5))
    const clips = v1(apply(p, [cut({ order: 'bestMoments' })], () => analysis).project)
    expect(clips).toHaveLength(4)
    expect(clips[0]!.sourceIn).toBeGreaterThanOrEqual(0.85 - 1e-9)
    expect(clips[0]!.sourceIn).toBeLessThanOrEqual(1.2)
    expect(clips[1]!.sourceIn).toBeGreaterThanOrEqual(3.85 - 1e-9)
    expect(clips[1]!.sourceIn).toBeLessThanOrEqual(4.4)
  })

  it('falls back to sequential without analysis', () => {
    const p = project(bassMarkers(3))
    const best = v1(apply(p, [cut({ order: 'bestMoments' })]).project)
    const seq = v1(apply(p, [cut()]).project)
    expect(best.map((c) => c.sourceIn)).toEqual(seq.map((c) => c.sourceIn))
  })
})

describe('cutToMarkers — errors', () => {
  const p = project(bassMarkers(5))
  const reject = (project: Project, op: CutOp, code: string) => {
    const before = JSON.stringify(project)
    let err: unknown
    try {
      apply(project, [op])
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(OpsError)
    expect((err as OpsError).code).toBe(code)
    expect(JSON.stringify(project)).toBe(before)
  }

  it('needs at least two markers after filtering', () => {
    reject(p, cut({ filter: { minStrength: 0.99, every: 3 } }), 'no_slots')
    reject(p, cut({ filter: { kinds: ['downbeat'] } }), 'no_slots')
  })

  it('rejects unknown clips, audio clips, bad tracks and empty lists', () => {
    reject(p, cut({ clipIds: ['clp_nope'] }), 'clip_not_found')
    reject(p, cut({ clipIds: ['clp_music'] }), 'incompatible_track')
    reject(p, cut({ trackId: 'trk_nope' }), 'track_not_found')
    reject(p, cut({ trackId: 'trk_a1' }), 'incompatible_track')
    reject(p, cut({ trackId: 'trk_fx' }), 'incompatible_track')
    reject(p, { ...cut(), clipIds: [] }, 'bad_value')
  })

  it('refuses to overwrite other clips under the slots', () => {
    const busy = apply(p, [
      {
        op: 'addClip',
        trackId: 'trk_v1',
        clip: {
          type: 'clip',
          assetId: videoAsset.id,
          start: 11,
          duration: 1,
          sourceIn: 5,
          sourceOut: 6,
          speed: 1,
          reverse: false,
          transform: { x: 0, y: 0, scale: 1, rotation: 0, anchorX: 0, anchorY: 0 },
          opacity: 1,
          blendMode: 'normal',
          effects: [],
          markers: [],
        },
      },
    ]).project
    reject(busy, cut(), 'slots_overlap')
    // на свободной дорожке — можно
    expect(() => apply(busy, [cut({ trackId: 'trk_v2' })])).not.toThrow()
  })
})

describe('countSlots / expandCutToMarkers', () => {
  it('previews the slot count without changing the project', () => {
    const p = project(bassMarkers(9))
    const before = JSON.stringify(p)
    expect(countSlots(p, { filter: {} })).toBe(8)
    expect(countSlots(p, { filter: { every: 2 } })).toBe(4)
    expect(countSlots(p, { filter: { kinds: ['beat'] } })).toBe(0)
    const ops = expandCutToMarkers(p, cut())
    expect(ops.filter((o) => o.op === 'removeClip')).toHaveLength(2)
    expect(ops.filter((o) => o.op === 'addClip')).toHaveLength(8)
    expect(JSON.stringify(p)).toBe(before)
  })
})
