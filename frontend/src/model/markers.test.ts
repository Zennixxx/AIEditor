import { describe, expect, it } from 'vitest'
import { fixtures } from '@/api/mocks/fixtures'
import type { EditOp, MusicAnalysis, Project } from '@/shared/types.gen'
import { checkInvariants } from './invariants'
import { findClip, findMarker } from './lookup'
import {
  analysisMarkers,
  analysisSections,
  DEFAULT_VISIBILITY,
  isMarkerVisible,
  markerOrigins,
  neighborMarkerTime,
  planAddMarker,
  planApplyAnalysis,
  planDeleteMarkers,
  planMoveMarkers,
  thinMarkers,
  timelineMarkers,
} from './markers'
import { applyOps } from './ops/applyOps'
import { sectionSpanOnTimeline, timelineSections } from './sections'
import { audioAsset, musicProject, seqIds, videoAsset } from './testUtils'

const apply = (p: Project, ops: EditOp[]) => applyOps(p, ops, { newId: seqIds() })

const analysis: MusicAnalysis = {
  assetId: audioAsset.id,
  params: { bassCutoffHz: 150, sensitivity: 0.5, minGapSec: 0.12, useStems: false },
  bpm: 120,
  beats: [0, 0.5, 1, 1.5, 2],
  downbeats: [0, 2],
  bass: [
    { t: 0.001, strength: 0.4 },
    { t: 1, strength: 0.9 },
  ],
  onsets: [{ t: 0.25, strength: 0.2 }],
  sections: [
    { start: 0, end: 1.2, label: 'intro', energy: 0.3 },
    { start: 1.2, end: 3, label: 'drop', energy: 1 },
  ],
  energy: { interval: 0.1, values: [0.5] },
}

describe('analysis → ops (CONTRACT §4)', () => {
  it('maps bass/downbeat/beat/onset; beats equal to a downbeat (±1 ms) are not duplicated', () => {
    const ms = analysisMarkers({ ...analysis, beats: [0, 0.0005, 0.5, 2] })
    const kinds = (k: string) => ms.filter((m) => m.kind === k)
    expect(kinds('downbeat').map((m) => m.t)).toEqual([0, 2])
    expect(kinds('beat').map((m) => m.t)).toEqual([0.5])
    expect(kinds('bass')).toHaveLength(2)
    expect(kinds('bass')[1]!.strength).toBe(0.9)
    expect(kinds('onset')).toHaveLength(1)
    expect(kinds('beat')[0]!.strength).toBe(1)
    expect(ms.map((m) => m.t)).toEqual([...ms.map((m) => m.t)].sort((a, b) => a - b))
  })

  it('analysis sections are sanitized into a valid setSections list', () => {
    const secs = analysisSections({
      ...analysis,
      sections: [
        { start: 2, end: 4, label: 'drop', energy: 2 },
        { start: 0, end: 2.5, label: 'intro', energy: 0.1 },
        { start: 3, end: 3, label: 'other', energy: 0 },
      ],
    })
    expect(secs.map((s) => [s.start, s.end, s.label])).toEqual([
      [0, 2.5, 'intro'],
      [2.5, 4, 'drop'],
    ])
    expect(secs[1]!.energy).toBe(1)
  })

  it('applies as one transaction: markers into clip.markers, sections into clip.sections', () => {
    const p = musicProject()
    const ops = planApplyAnalysis(p, 'clp_music', analysis)
    expect(ops.map((o) => o.op)).toEqual(['addMarkers', 'setSections'])
    const res = apply(p, ops)
    const c = findClip(res.project, 'clp_music')!.clip
    expect(c.markers.map((m) => m.kind).sort()).toEqual(
      ['bass', 'bass', 'beat', 'beat', 'beat', 'downbeat', 'downbeat', 'onset'].sort(),
    )
    expect(c.sections).toHaveLength(2)
    expect(res.project.sections).toEqual([]) // project.sections не трогаем
    expect(checkInvariants(res.project)).toEqual([])
  })

  it('re-analysis replaces bass/beat/downbeat/onset and clip.sections, keeps manual and ai', () => {
    const p = musicProject()
    const first = apply(p, planApplyAnalysis(p, 'clp_music', analysis)).project
    const withManual = apply(first, [
      {
        op: 'addMarkers',
        target: { clipId: 'clp_music' },
        markers: [
          { t: 25, kind: 'manual', strength: 1, label: 'hit' },
          { t: 26, kind: 'ai', strength: 0.7 },
        ],
      },
    ]).project
    const next: MusicAnalysis = { ...analysis, bass: [{ t: 30, strength: 0.5 }], beats: [], downbeats: [] }
    const ops = planApplyAnalysis(withManual, 'clp_music', next)
    expect(ops.map((o) => o.op)).toEqual(['removeMarkers', 'addMarkers', 'setSections'])
    const c = findClip(apply(withManual, ops).project, 'clp_music')!.clip
    expect(c.markers.filter((m) => m.kind === 'manual' || m.kind === 'ai')).toHaveLength(2)
    expect(c.markers.filter((m) => m.kind === 'bass')).toHaveLength(1)
    expect(c.markers.filter((m) => m.kind === 'beat' || m.kind === 'downbeat')).toHaveLength(0)
    expect(c.markers.some((m) => m.kind === 'onset')).toBe(true)
  })

  it('does nothing for clips that cannot hold analysis or are missing', () => {
    const p = musicProject()
    p.assets.find((a) => a.id === videoAsset.id)!.hasAudio = false
    expect(planApplyAnalysis(p, 'clp_a', analysis)).toEqual([])
    expect(planApplyAnalysis(p, 'clp_nope', analysis)).toEqual([])
  })

  it('fixture analysis produces a valid project transaction', () => {
    const p = musicProject()
    const res = apply(p, planApplyAnalysis(p, 'clp_music', fixtures.musicAnalysis))
    expect(checkInvariants(res.project)).toEqual([])
    expect(findClip(res.project, 'clp_music')!.clip.markers.length).toBeGreaterThan(300)
  })
})

describe('visibility, timeline positions, navigation', () => {
  it('onset is hidden by default; threshold hides weak markers', () => {
    expect(isMarkerVisible({ kind: 'onset', strength: 1 }, DEFAULT_VISIBILITY)).toBe(false)
    expect(isMarkerVisible({ kind: 'bass', strength: 0.3 }, DEFAULT_VISIBILITY)).toBe(true)
    expect(
      isMarkerVisible({ kind: 'bass', strength: 0.3 }, { ...DEFAULT_VISIBILITY, minStrength: 0.5 }),
    ).toBe(false)
    expect(isMarkerVisible({ kind: 'manual', strength: 1 }, { ...DEFAULT_VISIBILITY, minStrength: 1 })).toBe(
      true,
    )
  })

  it('clip markers are converted to timeline time; out-of-range ones are dropped', () => {
    const p = musicProject()
    const res = apply(p, [
      {
        op: 'addMarkers',
        target: { clipId: 'clp_music' },
        markers: [
          { t: 25, kind: 'bass', strength: 0.5 }, // → 10 + 5
          { t: 10, kind: 'bass', strength: 0.5 }, // до sourceIn
        ],
      },
      { op: 'addMarkers', target: 'project', markers: [{ t: 3, kind: 'manual', strength: 1 }] },
    ])
    const list = timelineMarkers(res.project)
    expect(list.map((m) => m.t)).toEqual([3, 15])
    expect(list[1]!.clipId).toBe('clp_music')
    // фильтр
    const hidden = timelineMarkers(res.project, { minStrength: 0.9, kinds: ['bass'] })
    expect(hidden).toEqual([])
  })

  it('neighborMarkerTime finds the next/previous marker', () => {
    const mk = (t: number) => ({
      marker: { id: 'm', t, kind: 'bass' as const, strength: 1 },
      clipId: null,
      t,
    })
    const list = [mk(1), mk(2), mk(4)]
    expect(neighborMarkerTime(list, 2, 1)).toBe(4)
    expect(neighborMarkerTime(list, 2, -1)).toBe(1)
    expect(neighborMarkerTime(list, 0, -1)).toBeNull()
    expect(neighborMarkerTime(list, 4, 1)).toBeNull()
    expect(neighborMarkerTime(list, 1.5, 1)).toBe(2)
  })

  it('thinMarkers keeps only the strongest marker of a cluster closer than 3 px', () => {
    const mk = (id: string, t: number, strength: number, clipId: string | null = 'c') => ({
      marker: { id, t, kind: 'bass' as const, strength },
      clipId,
      t,
    })
    const list = [mk('a', 0, 0.2), mk('b', 0.02, 0.9), mk('c', 0.04, 0.5), mk('d', 1, 0.3)]
    // 100 px/s → расстояния 2, 2, 96 px
    expect(thinMarkers(list, 100).map((m) => m.marker.id)).toEqual(['b', 'd'])
    // крупный зум — все на месте
    expect(thinMarkers(list, 1000)).toHaveLength(4)
    // выделенный побеждает более сильного
    expect(thinMarkers(list, 100, 3, new Set(['a'])).map((m) => m.marker.id)).toEqual(['a', 'd'])
    // маркер проекта в том же месте — отдельный кластер
    expect(thinMarkers([mk('p', 0.01, 0.1, null), ...list], 100)).toHaveLength(3)
    // другой вид в том же месте не вытесняется (плотные beat не прячут bass)
    const beat = { marker: { id: 'bt', t: 0.01, kind: 'beat' as const, strength: 1 }, clipId: 'c', t: 0.01 }
    expect(thinMarkers([list[0]!, beat, list[1]!], 100).map((m) => m.marker.id)).toEqual(['bt', 'b'])
  })
})

describe('manual markers', () => {
  it('M on a selected audio clip adds a manual marker in source time, quantized to the frame', () => {
    const p = musicProject()
    const ops = planAddMarker(p, 12.51, ['clp_music'])
    expect(ops).toHaveLength(1)
    const res = apply(p, ops)
    const m = findClip(res.project, 'clp_music')!.clip.markers[0]!
    expect(m.kind).toBe('manual')
    expect(m.strength).toBe(1)
    // 12.51 → кадр 12.5333…; source = 20 + (12.5333 − 10)
    expect(m.t).toBeCloseTo(20 + (Math.round(12.51 * 30) / 30 - 10), 9)
  })

  it('M without a selected audio clip (or outside it) adds a project marker', () => {
    const p = musicProject()
    expect(planAddMarker(p, 1, [])[0]).toMatchObject({ target: 'project' })
    expect(planAddMarker(p, 1, ['clp_music'])[0]).toMatchObject({ target: 'project' }) // плейхед до клипа
    expect(planAddMarker(p, 12, ['clp_a'])[0]).toMatchObject({ target: 'project' }) // видеоклип
  })

  it('delete removes markers; unknown ids are ignored', () => {
    const p = apply(musicProject(), planAddMarker(musicProject(), 12, ['clp_music'])).project
    const id = findClip(p, 'clp_music')!.clip.markers[0]!.id
    expect(planDeleteMarkers(p, ['mrk_nope'])).toEqual([])
    const res = apply(p, planDeleteMarkers(p, [id, 'mrk_nope']))
    expect(findMarker(res.project, id)).toBeUndefined()
  })

  it('moving a clip marker converts the timeline delta to source time (speed 2×)', () => {
    let p = musicProject({ speed: 2, duration: 15 }) // source 20..50 за 15 с
    p = apply(p, [
      {
        op: 'addMarkers',
        target: { clipId: 'clp_music' },
        markers: [{ id: 'mrk_x', t: 30, kind: 'manual', strength: 1 }],
      },
      { op: 'addMarkers', target: 'project', markers: [{ id: 'mrk_p', t: 5, kind: 'manual', strength: 1 }] },
    ]).project
    const origins = markerOrigins(p, ['mrk_x', 'mrk_p'])
    expect(origins).toEqual([
      { id: 'mrk_x', clipId: 'clp_music', t: 15 }, // 10 + (30 − 20) / 2
      { id: 'mrk_p', clipId: null, t: 5 },
    ])
    const moved = apply(p, planMoveMarkers(p, origins, 1)).project
    expect(findMarker(moved, 'mrk_x')!.marker.t).toBeCloseTo(32, 9) // +1 с таймлайна = +2 с исходника
    expect(findMarker(moved, 'mrk_p')!.marker.t).toBeCloseTo(6, 9)
    // ограничения: не левее клипа/нуля и не правее клипа
    const far = apply(p, planMoveMarkers(p, origins, -100)).project
    expect(findMarker(far, 'mrk_x')!.marker.t).toBeCloseTo(20, 9)
    expect(findMarker(far, 'mrk_p')!.marker.t).toBe(0)
    const right = apply(p, planMoveMarkers(p, origins, 100)).project
    expect(findMarker(right, 'mrk_x')!.marker.t).toBeCloseTo(50, 9)
  })
})

describe('sections on the timeline', () => {
  it('clip sections are converted to timeline time and clipped to the visible range', () => {
    const p = musicProject() // start 10, source 20..50
    const res = apply(p, [
      {
        op: 'setSections',
        target: { clipId: 'clp_music' },
        sections: [
          { start: 0, end: 25, label: 'intro', energy: 0.2 }, // обрезается слева: 20..25
          { start: 25, end: 45, label: 'drop', energy: 1 },
          { start: 45, end: 80, label: 'outro', energy: 0.1 }, // обрезается справа: 45..50
          { start: 90, end: 99, label: 'other', energy: 0 }, // целиком вне клипа
        ],
      },
    ])
    const clip = findClip(res.project, 'clp_music')!.clip
    expect(sectionSpanOnTimeline(clip, clip.sections![0]!)).toEqual([10, 15])
    expect(sectionSpanOnTimeline(clip, clip.sections![3]!)).toBeNull()
    const all = timelineSections(res.project)
    expect(all.map((s) => [s.label, s.start, s.end])).toEqual([
      ['intro', 10, 15],
      ['drop', 15, 35],
      ['outro', 35, 40],
    ])
  })

  it('sections follow the clip on moveClip and include project.sections', () => {
    const p = musicProject()
    const withSec = apply(p, [
      {
        op: 'setSections',
        target: { clipId: 'clp_music' },
        sections: [{ start: 20, end: 30, label: 'drop', energy: 1 }],
      },
      { op: 'setSections', target: 'project', sections: [{ start: 1, end: 2, label: 'other', energy: 0.5 }] },
    ]).project
    const moved = apply(withSec, [{ op: 'moveClip', clipId: 'clp_music', start: 20 }]).project
    expect(timelineSections(moved).map((s) => [s.clipId, s.start, s.end])).toEqual([
      [null, 1, 2],
      ['clp_music', 20, 30],
    ])
  })
})
