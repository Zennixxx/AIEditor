import { describe, expect, it } from 'vitest'
import { findClip } from '@/model/lookup'
import { sampleProject } from '@/model/testUtils'
import {
  followPlayhead,
  hitTest,
  itemsInRect,
  LANE_H,
  laneScreenTop,
  layoutTracks,
  RULER_H,
  TRACK_H,
  timeToX,
  xToTime,
  type View,
} from './geometry'
import { hitKey, layoutKeys } from './keyLayout'
import { rulerStep, rulerTicks } from './ruler'

const view: View = { pxPerSec: 100, scrollX: 0, scrollY: 0, width: 1000, height: 400 }

describe('timeline geometry', () => {
  it('converts time and x both ways', () => {
    const v = { ...view, scrollX: 2 }
    expect(timeToX(3, v)).toBe(100)
    expect(xToTime(100, v)).toBe(3)
  })

  it('lays tracks out in display order (top layer first, audio below)', () => {
    const rows = layoutTracks(sampleProject())
    expect(rows.map((r) => r.track.id)).toEqual(['trk_fx', 'trk_v2', 'trk_v1', 'trk_a1'])
    expect(rows[1]!.top).toBe(rows[0]!.height)
  })

  it('property lanes extend video rows only and are hit-tested below the clips', () => {
    const rows = layoutTracks(sampleProject(), ['position', 'opacity'])
    const v1 = rows.find((r) => r.track.id === 'trk_v1')!
    expect(v1.itemHeight).toBe(TRACK_H.video)
    expect(v1.height).toBe(TRACK_H.video + 2 * LANE_H)
    expect(rows.find((r) => r.track.id === 'trk_fx')!.lanes).toEqual([])
    const top = laneScreenTop(v1, 'opacity', view)!
    expect(top).toBe(RULER_H + v1.top + TRACK_H.video + LANE_H)
    const hit = hitTest(rows, view, 50, top + 4)
    expect(hit.area === 'lane' && hit.lane).toBe('opacity')
    // клип — только в полосе элементов
    expect(hitTest(rows, view, 50, RULER_H + v1.top + 10).area).toBe('item')
  })

  it('lays out keyframes on lanes and hit-tests them', () => {
    const p = sampleProject()
    findClip(p, 'clp_b')!.clip.transform.scale = [
      { t: 0.5, v: 1, ease: 'linear' },
      { t: 1, v: 2, ease: 'hold' },
    ]
    const rows = layoutTracks(p, ['scale'])
    const keys = layoutKeys(rows, view, [{ clipId: 'clp_b', lane: 'scale', t: 1 }])
    expect(keys.map((k) => [k.x, k.ease, k.selected])).toEqual([
      [250, 'linear', false],
      [300, 'hold', true],
    ])
    expect(hitKey(keys, 303, keys[1]!.y)?.ref.t).toBe(1)
    expect(hitKey(keys, 320, keys[1]!.y)).toBeNull()
    expect(layoutKeys(layoutTracks(p), view, [])).toEqual([])
  })

  it('hit-tests ruler, item body, trim edges and empty track', () => {
    const rows = layoutTracks(sampleProject())
    const v1 = rows.find((r) => r.track.id === 'trk_v1')!
    const y = RULER_H + v1.top + 10
    expect(hitTest(rows, view, 50, 5).area).toBe('ruler')
    expect(hitTest(rows, view, 100, y)).toMatchObject({ area: 'item', zone: 'body' })
    expect(hitTest(rows, view, 3, y)).toMatchObject({ area: 'item', zone: 'start' })
    expect(hitTest(rows, view, 197, y)).toMatchObject({ area: 'item', zone: 'end' })
    expect(hitTest(rows, view, 600, y)).toMatchObject({ area: 'track' })
    expect(hitTest(rows, view, 600, 399).area).toBe('empty')
  })

  it('box-selects items crossing the rectangle', () => {
    const rows = layoutTracks(sampleProject())
    const v1 = rows.find((r) => r.track.id === 'trk_v1')!
    const y = RULER_H + v1.top + 10
    expect(itemsInRect(rows, view, { x0: 150, y0: y, x1: 250, y1: y + 5 })).toEqual(['clp_a', 'clp_b'])
  })

  it('follows the playhead page-wise while playing', () => {
    expect(followPlayhead(view, 5)).toBe(0)
    expect(followPlayhead(view, 12)).toBeCloseTo(12 - 0.4)
  })
})

describe('ruler', () => {
  it('uses frames when zoomed in, seconds and minutes when zoomed out', () => {
    expect(rulerStep(3000, 30).major).toBeCloseTo(1 / 30)
    expect(rulerStep(100, 30).major).toBe(1)
    expect(rulerStep(1, 30).major).toBe(120)
  })

  it('labels major ticks with mm:ss:ff timecode', () => {
    const ticks = rulerTicks(0, 3, 100, 30)
    const labels = ticks.filter((t) => t.major).map((t) => t.label)
    expect(labels.slice(0, 3)).toEqual(['00:00:00', '00:01:00', '00:02:00'])
    expect(ticks.some((t) => !t.major)).toBe(true)
  })
})
