import { describe, expect, it } from 'vitest'
import { FrameCursor, type SampleSource, type TimedSample } from './frameCursor'

class FakeSample implements TimedSample {
  closed = false
  constructor(
    readonly timestamp: number,
    private readonly live: Set<FakeSample>,
  ) {
    live.add(this)
  }
  close(): void {
    this.closed = true
    this.live.delete(this)
  }
}

function fakeSource(fps: number, count: number, firstAt = 0) {
  const live = new Set<FakeSample>()
  let decoded = 0
  const ts = (i: number) => firstAt + i / fps
  const index = (t: number) => Math.min(count - 1, Math.floor((t - firstAt) * fps + 1e-9))
  const source: SampleSource<FakeSample> = {
    async *samples(start: number) {
      for (let i = Math.max(0, index(start)); i < count; i++) {
        decoded++
        yield new FakeSample(ts(i), live)
      }
    },
    async getSample(t: number) {
      if (t < firstAt) return null
      decoded++
      return new FakeSample(ts(index(t)), live)
    },
  }
  return { source, live, decoded: () => decoded }
}

describe('FrameCursor', () => {
  it('walks forward without restarting and picks the frame shown at t', async () => {
    const { source, live } = fakeSource(15, 60)
    const cursor = new FrameCursor(source)
    const seen: number[] = []
    for (let i = 0; i < 60; i++) {
      const s = await cursor.at(1 + i / 30)
      seen.push(Math.round(s!.timestamp * 15))
    }
    expect(seen.slice(0, 6)).toEqual([15, 15, 16, 16, 17, 17])
    expect(cursor.restarts).toBe(1)
    await cursor.dispose()
    expect(live.size).toBe(0)
  })

  it('treats frame boundaries within epsilon as the new frame', async () => {
    const { source } = fakeSource(10, 30)
    const cursor = new FrameCursor(source)
    expect((await cursor.at(0.3 - 1e-6))!.timestamp).toBeCloseTo(0.3, 9)
    expect((await cursor.at(0.39))!.timestamp).toBeCloseTo(0.3, 9)
    await cursor.dispose()
  })

  it('restarts on backward seeks and long jumps, closing what it held', async () => {
    const { source, live } = fakeSource(30, 600)
    const cursor = new FrameCursor(source)
    await cursor.at(5)
    await cursor.at(4)
    expect(cursor.restarts).toBe(2)
    await cursor.at(4.5)
    expect(cursor.restarts).toBe(2)
    await cursor.at(15)
    expect(cursor.restarts).toBe(3)
    expect(live.size).toBeLessThanOrEqual(2)
    await cursor.dispose()
    expect(live.size).toBe(0)
  })

  it('holds the last frame past the end and the first frame before the start', async () => {
    const { source, live } = fakeSource(10, 5, 0.05)
    const cursor = new FrameCursor(source)
    expect((await cursor.at(0))!.timestamp).toBeCloseTo(0.05, 9)
    expect((await cursor.at(3))!.timestamp).toBeCloseTo(0.45, 9)
    expect((await cursor.at(3.1))!.timestamp).toBeCloseTo(0.45, 9)
    await cursor.dispose()
    expect(live.size).toBe(0)
  })

  it('serves reverse playback through restarts', async () => {
    const { source, live } = fakeSource(30, 90)
    const cursor = new FrameCursor(source)
    const seen: number[] = []
    for (let i = 0; i < 10; i++) seen.push(Math.round((await cursor.at(2 - i / 30))!.timestamp * 30))
    expect(seen).toEqual([60, 59, 58, 57, 56, 55, 54, 53, 52, 51])
    await cursor.dispose()
    expect(live.size).toBe(0)
  })
})
