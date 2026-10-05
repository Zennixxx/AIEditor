import { describe, expect, it } from 'vitest'
import { canPlayNatively, correctDrift, MAX_VIDEO_RATE, onFrame, ScrubTracker } from './drift'
import { containRect, coverSource } from './frame'

const FPS = 30

describe('drift correction', () => {
  it('within one frame — nothing to do', () => {
    expect(correctDrift(5, 5 + 0.5 / FPS, 1, FPS)).toEqual({ kind: 'ok', rate: 1 })
  })

  it('more than a frame — nudges playbackRate toward the clock', () => {
    const behind = correctDrift(5, 5.05, 1, FPS)
    expect(behind.kind).toBe('nudge')
    expect(behind.rate).toBeGreaterThan(1)
    expect(behind.rate).toBeLessThanOrEqual(1.25)
    const ahead = correctDrift(5.05, 5, 0.5, FPS)
    expect(ahead.kind).toBe('nudge')
    expect(ahead.rate).toBeLessThan(0.5)
  })

  it('more than 0.1 s — seek', () => {
    expect(correctDrift(5, 5.2, 1, FPS)).toEqual({ kind: 'seek', to: 5.2, rate: 1 })
    expect(correctDrift(7, 5, 2, FPS)).toMatchObject({ kind: 'seek', to: 5 })
  })

  it('rates outside the browser range are clamped / played by seeking', () => {
    expect(correctDrift(1, 1, 40, FPS).rate).toBe(MAX_VIDEO_RATE)
    expect(canPlayNatively(1)).toBe(true)
    expect(canPlayNatively(-1)).toBe(false)
    expect(canPlayNatively(0.01)).toBe(false)
  })

  it('onFrame — half a frame tolerance', () => {
    expect(onFrame(1, 1 + 0.4 / FPS, FPS)).toBe(true)
    expect(onFrame(1, 1 + 0.6 / FPS, FPS)).toBe(false)
  })
})

describe('scrub tracker', () => {
  it('fast while the playhead moves quickly, settles after the window', () => {
    const s = new ScrubTracker()
    s.push(0, 0)
    s.push(1, 0.05)
    s.push(2, 0.1)
    expect(s.isFast(0.1)).toBe(true)
    expect(s.isFast(0.5)).toBe(false)
  })

  it('slow nudges (frame stepping) are not fast', () => {
    const s = new ScrubTracker()
    s.push(1, 0)
    s.push(1 + 1 / FPS, 0.1)
    expect(s.isFast(0.1)).toBe(false)
  })
})

describe('preview frame geometry', () => {
  it('contain: project aspect fits the viewport', () => {
    expect(containRect(1920, 1080, 800, 600)).toEqual({ x: 0, y: 75, w: 800, h: 450 })
    expect(containRect(1080, 1920, 800, 800)).toEqual({ x: 175, y: 0, w: 450, h: 800 })
  })

  it('cover: crops the source to the output aspect (scale 1 = cover)', () => {
    // 4:3 источник в 16:9 выход — обрезка сверху/снизу
    const r = coverSource(640, 480, 1920, 1080)
    expect(r.x).toBeCloseTo(0)
    expect(r.w).toBeCloseTo(640)
    expect(r.h).toBeCloseTo(360)
    expect(r.y).toBeCloseTo(60)
    expect(coverSource(1920, 1080, 960, 540)).toEqual({ x: 0, y: 0, w: 1920, h: 1080 })
  })
})
