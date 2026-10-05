import { describe, expect, it } from 'vitest'
import type { Clip, EditOp, MarkerInput, Project } from '@/shared/types.gen'
import { checkInvariants } from './invariants'
import { findClip } from './lookup'
import { applyOps, OpsError } from './ops/applyOps'
import { planRippleTrack } from './ripple'
import { expandSnapClipEdges, nearestWithin, type SnapEdgesOp } from './snapClipEdges'
import { clip, musicProject, seqIds, track } from './testUtils'

const apply = (p: Project, ops: EditOp[]) => applyOps(p, ops, { newId: seqIds() })

/** Bass-маркеры на timeline 10 + t (музыка: timeline 10 = source 20). */
function withMarkers(p: Project, times: number[]): Project {
  const markers: MarkerInput[] = times.map((t) => ({ t: t + 20, kind: 'bass', strength: 1 }))
  return apply(p, [{ op: 'addMarkers', target: { clipId: 'clp_music' }, markers }]).project
}

const snap = (clipIds: string[], maxShift: number, filter: SnapEdgesOp['filter'] = {}): SnapEdgesOp => ({
  op: 'snapClipEdgesToMarkers',
  clipIds,
  filter,
  maxShift,
})

/** Проект: видеоклип на 12.1..14.9 (source 1..3.8), маркеры на timeline 12, 13, 15. */
function scene(extra: Partial<Clip> = {}): Project {
  const p = withMarkers(musicProject(), [2, 3, 5]) // timeline 12, 13, 15
  const c = clip('clp_x', 12.1, 2.8, { sourceIn: 1, sourceOut: 3.8, ...extra })
  return apply(p, [{ op: 'addClip', trackId: 'trk_v2', clip: { ...c, type: 'clip' } }]).project
}

describe('nearestWithin', () => {
  it('returns the nearest point within maxShift or null', () => {
    expect(nearestWithin([1, 2, 5], 2.4, 0.5)).toBe(2)
    expect(nearestWithin([1, 2, 5], 3.5, 0.5)).toBeNull()
    expect(nearestWithin([1, 2, 5], 4.6, 0.5)).toBe(5)
    expect(nearestWithin([], 1, 5)).toBeNull()
  })
})

describe('snapClipEdgesToMarkers', () => {
  it('trims both edges to the nearest markers within maxShift', () => {
    const p = scene()
    const { project: next } = apply(p, [snap(['clp_x'], 0.3)])
    const c = findClip(next, 'clp_x')!.clip
    // начало 12.1 → 12 (удлиняем: source 0.9), конец 14.9 → 15 (source 3.9)
    expect(c.start).toBeCloseTo(12, 9)
    expect(c.start + c.duration).toBeCloseTo(15, 9)
    expect(c.sourceIn).toBeCloseTo(0.9, 9)
    expect(c.sourceOut).toBeCloseTo(3.9, 9)
    expect(checkInvariants(next)).toEqual([])
  })

  it('leaves edges that have no marker within maxShift', () => {
    const p = scene()
    const { project: next } = apply(p, [snap(['clp_x'], 0.05)])
    expect(findClip(next, 'clp_x')!.clip).toEqual(findClip(p, 'clp_x')!.clip)
    expect(expandSnapClipEdges(p, snap(['clp_x'], 0.05))).toEqual([])
  })

  it('respects the marker filter', () => {
    const p = scene()
    // каждый 2-й: 12, 15 (13 отфильтрован) — начало тянется к 12, конец к 15
    const ops = expandSnapClipEdges(p, snap(['clp_x'], 0.3, { every: 2 }))
    expect(ops).toHaveLength(1)
    const none = expandSnapClipEdges(p, snap(['clp_x'], 0.3, { kinds: ['beat'] }))
    expect(none).toEqual([])
  })

  it('is limited by neighbours on the track (never overlaps)', () => {
    let p = scene()
    // сосед справа начинается на 14.95 — край клипа не может уйти дальше него
    p = apply(p, [
      {
        op: 'addClip',
        trackId: 'trk_v2',
        clip: { ...clip('clp_n', 14.95, 1, { sourceIn: 5, sourceOut: 6 }), type: 'clip' },
      },
    ]).project
    const { project: next } = apply(p, [snap(['clp_x'], 0.3)])
    expect(checkInvariants(next)).toEqual([])
    const c = findClip(next, 'clp_x')!.clip
    expect(c.start + c.duration).toBeLessThanOrEqual(14.95 + 1e-9)
  })

  it('is limited by the available source (cannot extend past the asset start)', () => {
    const p = scene({ sourceIn: 0.05, sourceOut: 2.85 })
    const c = findClip(apply(p, [snap(['clp_x'], 0.3)]).project, 'clp_x')!.clip
    expect(c.sourceIn).toBeGreaterThanOrEqual(0)
    // исходника хватает только на 0.05 с, а трим округляет внутрь до кадра: 12.05 → 12.0667
    expect(c.start).toBeGreaterThanOrEqual(12.05 - 1e-9)
    expect(c.start).toBeLessThan(12.1 - 1e-9)
  })

  it('processes adjacent clips left to right so a shared edge goes to one marker', () => {
    let p = withMarkers(musicProject(), [2.5]) // маркер timeline 12.5
    p = apply(p, [
      {
        op: 'addClip',
        trackId: 'trk_v2',
        clip: { ...clip('clp_l', 11, 1.4, { sourceOut: 1.4 }), type: 'clip' },
      },
      {
        op: 'addClip',
        trackId: 'trk_v2',
        clip: { ...clip('clp_r', 12.4, 1.6, { sourceIn: 3, sourceOut: 4.6 }), type: 'clip' },
      },
    ]).project
    const { project: next } = apply(p, [snap(['clp_l', 'clp_r'], 0.2)])
    const l = findClip(next, 'clp_l')!.clip
    const r = findClip(next, 'clp_r')!.clip
    expect(l.start + l.duration).toBeCloseTo(12.5, 9)
    expect(r.start).toBeCloseTo(12.5, 9)
    expect(checkInvariants(next)).toEqual([])
  })

  it('rejects unknown clips and bad maxShift', () => {
    const p = scene()
    expect(() => apply(p, [snap(['clp_nope'], 0.3)])).toThrow(OpsError)
    expect(() => apply(p, [snap(['clp_x'], -1)])).toThrow(OpsError)
    expect(() => apply(p, [snap(['clp_x'], Number.NaN)])).toThrow(OpsError)
  })
})

describe('planRippleTrack', () => {
  const p = (): Project => {
    const base = musicProject()
    const v = track('trk_r', 'video', [
      clip('clp_1', 1, 2),
      clip('clp_2', 4, 1), // пробел 1 с
      clip('clp_3', 5, 1), // впритык к clp_2, но после сдвига clp_2 тоже уезжает
      clip('clp_4', 8, 2), // пробел 2 с
    ])
    return { ...base, tracks: [...base.tracks, v] }
  }

  it('closes gaps between items and keeps the first item in place', () => {
    const ops = planRippleTrack(p(), 'trk_r')
    expect(ops).toEqual([
      { op: 'moveClip', clipId: 'clp_2', start: 3 },
      { op: 'moveClip', clipId: 'clp_3', start: 4 },
      { op: 'moveClip', clipId: 'clp_4', start: 5 },
    ])
    const { project: next } = apply(p(), ops)
    const starts = [1, 2, 3, 4].map((i) => findClip(next, `clp_${i}`)!.clip.start)
    expect(starts).toEqual([1, 3, 4, 5])
    expect(checkInvariants(next)).toEqual([])
  })

  it('returns nothing without gaps, on a locked or missing track', () => {
    const base = p()
    expect(planRippleTrack(base, 'trk_v1')).toEqual([]) // clp_a 0..2, clp_b 2..4 впритык
    expect(planRippleTrack(base, 'trk_missing')).toEqual([])
    base.tracks.find((t) => t.id === 'trk_r')!.locked = true
    expect(planRippleTrack(base, 'trk_r')).toEqual([])
  })

  it('moves effects on fx tracks too', () => {
    const base = musicProject()
    const fxItem = (id: string, start: number) => ({
      id,
      type: 'effect' as const,
      effect: 'shake',
      start,
      duration: 0.5,
      params: {},
      envelope: { attack: 0, hold: 0, decay: 0.5, curve: 'linear' as const },
      enabled: true,
    })
    const fx = track('trk_fx2', 'fx', [fxItem('fx_1', 0), fxItem('fx_2', 2)])
    const ops = planRippleTrack({ ...base, tracks: [...base.tracks, fx] }, 'trk_fx2')
    expect(ops).toEqual([{ op: 'updateEffect', effectId: 'fx_2', patch: { start: 0.5 } }])
  })
})
