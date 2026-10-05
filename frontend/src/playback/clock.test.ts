import { describe, expect, it } from 'vitest'
import {
  clockPause,
  clockPlay,
  clockSeek,
  clockSetRate,
  clockTime,
  MasterClock,
  shuttleRate,
  stoppedClock,
  type TimeSample,
} from './clock'

describe('master clock (pure)', () => {
  it('advances only while playing, scaled by rate', () => {
    let s = stoppedClock(2)
    expect(clockTime(s, 100)).toBe(2)
    s = clockPlay(s, 100, 1)
    expect(clockTime(s, 101.5)).toBeCloseTo(3.5)
    s = clockPause(s, 102)
    expect(clockTime(s, 500)).toBeCloseTo(4)
    s = clockPlay(s, 500, -2)
    expect(clockTime(s, 501)).toBeCloseTo(2)
  })

  it('seek and rate change keep continuity', () => {
    let s = clockPlay(stoppedClock(0), 10, 1)
    s = clockSeek(s, 11, 5)
    expect(clockTime(s, 12)).toBeCloseTo(6)
    s = clockSetRate(s, 12, 4)
    expect(clockTime(s, 12)).toBeCloseTo(6)
    expect(clockTime(s, 12.5)).toBeCloseTo(8)
  })

  it('J/L shuttle doubles in the same direction up to ×8, flips otherwise', () => {
    expect(shuttleRate({ playing: false, rate: 1 }, 1)).toBe(1)
    expect(shuttleRate({ playing: true, rate: 1 }, 1)).toBe(2)
    expect(shuttleRate({ playing: true, rate: 8 }, 1)).toBe(8)
    expect(shuttleRate({ playing: true, rate: 4 }, -1)).toBe(-1)
    expect(shuttleRate({ playing: true, rate: -2 }, -1)).toBe(-4)
  })
})

describe('MasterClock time source', () => {
  it('follows AudioContext time and switches sources without a jump', () => {
    const sample: TimeSample = { audio: null, perf: 1000 }
    const clock = new MasterClock(() => ({ ...sample }))
    clock.seek(3)
    clock.play(1)
    sample.perf = 1000.5
    expect(clock.time()).toBeCloseTo(3.5)
    expect(clock.sourceKind).toBe('perf')
    // AudioContext запустился: его шкала совсем другая (0.2), позиция не прыгает
    sample.perf = 1001
    sample.audio = 0.2
    expect(clock.time()).toBeCloseTo(4)
    expect(clock.sourceKind).toBe('audio')
    sample.audio = 1.2
    sample.perf = 1003 // performance больше не влияет
    expect(clock.time()).toBeCloseTo(5)
    clock.pause()
    sample.audio = 10
    expect(clock.time()).toBeCloseTo(5)
  })
})
