import { describe, expect, it } from 'vitest'
import { DEFAULT_VISIBILITY } from '@/model/markers'
import { musicProject } from '@/model/testUtils'
import type { Clip, Project } from '@/shared/types.gen'
import { layoutTracks, RULER_H, rowScreenTop, type View } from './geometry'
import { hitMarker, layoutMarkers, markersInRect } from './markerLayout'

const view: View = { pxPerSec: 100, scrollX: 0, scrollY: 0, width: 800, height: 400 }

function project(): Project {
  const p = musicProject() // музыка: start 10, source 20..50
  const clip = p.tracks.find((t) => t.id === 'trk_a1')!.items[0] as Clip
  clip.markers = [
    { id: 'mrk_a', t: 20.2, kind: 'bass', strength: 0.9 }, // 10.2 с → x = 1020 (за краем вида)
    { id: 'mrk_b', t: 20.0, kind: 'bass', strength: 0.4 },
  ]
  p.markers = [
    { id: 'mrk_p1', t: 2, kind: 'manual', strength: 1 },
    { id: 'mrk_on', t: 3, kind: 'onset', strength: 1 },
  ]
  return p
}

const v = { ...view, scrollX: 9.5 } // 9.5..19.5 с: клип в кадре

describe('marker layout', () => {
  it('hidden kinds and weak markers are not laid out', () => {
    const p = project()
    const rows = layoutTracks(p)
    const ids = (vis = DEFAULT_VISIBILITY, view2 = { ...view, scrollX: 0 }) =>
      layoutMarkers(p, rows, view2, vis, new Set()).map((m) => m.id)
    expect(ids()).toEqual(['mrk_p1']) // onset скрыт; клипа в кадре нет
    expect(ids({ ...DEFAULT_VISIBILITY, kinds: [...DEFAULT_VISIBILITY.kinds, 'onset'] })).toEqual([
      'mrk_p1',
      'mrk_on',
    ])
    expect(ids({ minStrength: 0.95, kinds: ['bass', 'manual'] })).toEqual(['mrk_p1'])
  })

  it('clip markers sit on top of their clip, project markers on the ruler', () => {
    const p = project()
    const rows = layoutTracks(p)
    const list = layoutMarkers(p, rows, { ...v, scrollX: 0 }, DEFAULT_VISIBILITY, new Set())
    expect(list.map((m) => m.id)).toEqual(['mrk_p1']) // клип с x≥1000 не в кадре
    const inClip = layoutMarkers(p, rows, v, DEFAULT_VISIBILITY, new Set())
    const b = inClip.find((m) => m.id === 'mrk_b')!
    const row = rows.find((r) => r.track.id === 'trk_a1')!
    expect(b.clipId).toBe('clp_music')
    expect(b.x).toBeCloseTo((10 - 9.5) * 100)
    expect(b.bandTop).toBe(rowScreenTop(row, v) + 2)
    expect(inClip.every((m) => m.lineFrom >= RULER_H)).toBe(true)
  })

  it('thins clusters closer than 3 px to the strongest marker', () => {
    const p = project()
    const rows = layoutTracks(p)
    // mrk_a (10.2) и mrk_b (10.0) на 100 px/s далеко; при 10 px/s — 2 px, остаётся сильнейший
    const far = { ...v, pxPerSec: 10, scrollX: 0 }
    const list = layoutMarkers(p, rows, far, DEFAULT_VISIBILITY, new Set())
    expect(list.filter((m) => m.clipId === 'clp_music').map((m) => m.id)).toEqual(['mrk_a'])
    // выделенный слабый побеждает
    const sel = layoutMarkers(p, rows, far, DEFAULT_VISIBILITY, new Set(['mrk_b']))
    expect(sel.filter((m) => m.clipId === 'clp_music').map((m) => m.id)).toEqual(['mrk_b'])
  })

  it('hit-tests triangles within ±5 px and the marker band only', () => {
    const p = project()
    const rows = layoutTracks(p)
    const list = layoutMarkers(p, rows, v, DEFAULT_VISIBILITY, new Set())
    const b = list.find((m) => m.id === 'mrk_b')!
    expect(hitMarker(list, b.x + 4, b.bandTop + 5)?.id).toBe('mrk_b')
    expect(hitMarker(list, b.x + 6, b.bandTop + 5)).toBeNull()
    expect(hitMarker(list, b.x, b.bandBottom + 20)).toBeNull() // ниже зоны треугольника
    const proj = layoutMarkers(p, rows, { ...v, scrollX: 0 }, DEFAULT_VISIBILITY, new Set())
    const p1 = proj[0]!
    expect(hitMarker(proj, p1.x, RULER_H - 5)?.id).toBe('mrk_p1')
    expect(hitMarker(proj, p1.x, 5)).toBeNull() // полоса секций — не маркер
  })

  it('Alt-box selects markers by x range and by the row (clip) or ruler (project) it touches', () => {
    const p = project()
    const rows = layoutTracks(p)
    const list = layoutMarkers(p, rows, v, DEFAULT_VISIBILITY, new Set())
    const row = rows.find((r) => r.track.id === 'trk_a1')!
    const top = rowScreenTop(row, v)
    const b = list.find((m) => m.id === 'mrk_b')!
    // рамка по строке аудиодорожки вокруг mrk_b
    expect(markersInRect(list, rows, v, { x0: b.x - 5, x1: b.x + 5, y0: top + 30, y1: top + 40 })).toEqual([
      'mrk_b',
    ])
    // та же по X, но в строке другой дорожки — маркер не задет
    const other = rows.find((r) => r.track.id === 'trk_v1')!
    const oy = rowScreenTop(other, v)
    expect(markersInRect(list, rows, v, { x0: b.x - 5, x1: b.x + 5, y0: oy + 10, y1: oy + 20 })).toEqual([])
  })
})
