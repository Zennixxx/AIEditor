import { describe, expect, it } from 'vitest'
import type { Clip } from '@/shared/types.gen'
import { collectSnapTargets, findSnap, snapPoint, snapSpan, snapThreshold, type SnapTarget } from './snapping'
import { sampleProject } from './testUtils'

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
})
