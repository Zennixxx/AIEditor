import { describe, expect, it } from 'vitest'
import type { Clip } from '@/shared/types.gen'
import { collectSnapTargets, findSnap, snapPoint, snapSpan, snapThreshold, type SnapTarget } from './snapping'
import { musicProject, sampleProject } from './testUtils'

const opts = { enabled: true, threshold: 0.1, fps: 30 }

describe('snapping', () => {
  it('converts the 8px screen threshold to seconds through zoom', () => {
    expect(snapThreshold(100)).toBeCloseTo(0.08)
    expect(snapThreshold(800)).toBeCloseTo(0.01)
  })

  it('prefers the playhead when distances are equal', () => {
    const targets: SnapTarget[] = [
      { t: 2, kind: 'edge' },
      { t: 2, kind: 'playhead' },
      { t: 2, kind: 'marker' },
    ]
    expect(findSnap([2.05], targets, 0.1)!.target.kind).toBe('playhead')
    // порядок целей не важен
    expect(findSnap([2.05], [...targets].reverse(), 0.1)!.target.kind).toBe('playhead')
  })

  it('picks the nearest target among both edges of the dragged object', () => {
    const targets: SnapTarget[] = [
      { t: 1, kind: 'playhead' },
      { t: 5.02, kind: 'edge' },
    ]
    // начало 0.95 → до плейхеда 0.05; конец 5.0 → до края 0.02 — выигрывает конец
    const hit = findSnap([0.95, 5.0], targets, 0.1)!
    expect(hit.edge).toBe(1)
    expect(hit.delta).toBeCloseTo(0.02)
  })

  it('does not snap beyond the threshold', () => {
    expect(findSnap([1], [{ t: 1.2, kind: 'playhead' }], 0.1)).toBeNull()
    const res = snapPoint(1, [{ t: 1.2, kind: 'playhead' }], opts)
    expect(res.snappedAt).toBeNull()
    expect(res.value).toBe(1)
  })

  it('quantizes the final value to the frame grid', () => {
    // без привязки — просто квантуется
    expect(snapSpan(1.012, 2, [], opts).value).toBeCloseTo(1, 9)
    // привязка к маркеру не на сетке кадров → результат на ближайшем кадре
    const res = snapSpan(0.95, 1, [{ t: 1.011, kind: 'marker' }], opts)
    expect(res.snappedAt).toBeCloseTo(1.011)
    expect(res.value * 30).toBeCloseTo(Math.round(res.value * 30), 9)
    expect(res.value).toBeCloseTo(1, 9)
  })

  it('can be disabled (Shift / global toggle)', () => {
    const res = snapSpan(0.95, 1, [{ t: 1, kind: 'playhead' }], { ...opts, enabled: false })
    expect(res.snappedAt).toBeNull()
    expect(res.value).toBeCloseTo(0.9666666, 5)
  })

  it('collects playhead, clip edges, clip markers in timeline time, project markers, sections and 0', () => {
    const p = sampleProject()
    const b = p.tracks[0]!.items[1] as Clip // start 2, source 3..5
    b.markers = [
      { id: 'mrk_in', t: 4, kind: 'bass', strength: 1 },
      { id: 'mrk_out', t: 9, kind: 'bass', strength: 1 }, // вне диапазона клипа
    ]
    p.markers = [{ id: 'mrk_p', t: 7, kind: 'manual', strength: 1 }]
    p.sections = [{ id: 'sec_1', start: 8, end: 9, label: 'drop', energy: 1 }]
    const targets = collectSnapTargets(p, { playhead: 1.5, exclude: new Set(['clp_a']) })
    const has = (kind: SnapTarget['kind'], t: number) =>
      targets.some((x) => x.kind === kind && Math.abs(x.t - t) < 1e-9)
    expect(has('playhead', 1.5)).toBe(true)
    expect(has('zero', 0)).toBe(true)
    expect(has('edge', 2) && has('edge', 4)).toBe(true)
    expect(has('marker', 3)).toBe(true) // source 4 → timeline 2 + (4 − 3)
    expect(targets.filter((x) => x.kind === 'marker').map((x) => x.t)).not.toContain(8)
    expect(has('marker', 7)).toBe(true)
    expect(has('section', 8) && has('section', 9)).toBe(true)
    // края исключённого клипа clp_a (0..2) — только через соседа clp_b (2) и ноль
    expect(targets.filter((x) => x.kind === 'edge').map((x) => x.t)).toEqual([2, 4, 1, 1.5])
  })

  it('includes clip sections (source → timeline time, clipped to the visible range)', () => {
    const p = musicProject() // клип: start 10, source 20..50
    const clip = p.tracks.find((t) => t.id === 'trk_a1')!.items[0] as Clip
    clip.sections = [
      { id: 'sec_1', start: 15, end: 30, label: 'intro', energy: 0.3 }, // 20..30 → 10..20
      { id: 'sec_2', start: 60, end: 70, label: 'drop', energy: 1 }, // вне клипа
    ]
    const targets = collectSnapTargets(p, { playhead: 0 })
    const sections = targets.filter((x) => x.kind === 'section').map((x) => x.t)
    expect(sections).toEqual([10, 20])
  })

  it('hidden and dragged markers are not snap targets', () => {
    const p = musicProject()
    const clip = p.tracks.find((t) => t.id === 'trk_a1')!.items[0] as Clip
    clip.markers = [
      { id: 'mrk_loud', t: 25, kind: 'bass', strength: 0.9 },
      { id: 'mrk_weak', t: 30, kind: 'bass', strength: 0.1 },
      { id: 'mrk_on', t: 35, kind: 'onset', strength: 1 },
    ]
    p.markers = [{ id: 'mrk_p', t: 3, kind: 'manual', strength: 1 }]
    const markerTimes = (o: Parameters<typeof collectSnapTargets>[1]) =>
      collectSnapTargets(p, o)
        .filter((x) => x.kind === 'marker')
        .map((x) => x.t)
    // marker «mrk_weak» (source 30) → timeline 20; «mrk_on» (35) → 25; «mrk_loud» (25) → 15
    expect(markerTimes({ playhead: 0 })).toEqual([15, 20, 25, 3])
    expect(
      markerTimes({ playhead: 0, markerVisible: (m) => m.strength >= 0.5 && m.kind !== 'onset' }),
    ).toEqual([15, 3])
    expect(markerTimes({ playhead: 0, excludeMarkers: new Set(['mrk_loud', 'mrk_p']) })).toEqual([20, 25])
  })
})
