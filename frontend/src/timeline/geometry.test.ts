import { describe, expect, it } from 'vitest'
import { sampleProject } from '@/model/testUtils'
import {
  followPlayhead,
  hitTest,
  itemsInRect,
  layoutTracks,
  RULER_H,
  timeToX,
  xToTime,
  type View,
} from './geometry'
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
