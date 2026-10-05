import { describe, expect, it } from 'vitest'
import { fixtures } from '@/api/mocks/fixtures'
import type { Thumbs } from '@/shared/types.gen'
import { atlasRows, peakIndex, thumbTile, tilesPerSprite } from './media'

const thumbs = (extra: Partial<Thumbs> = {}): Thumbs => ({
  interval: 0.5,
  tileWidth: 160,
  tileHeight: 90,
  columns: 4,
  count: 30,
  sprites: ['/s/0.jpg', '/s/1.jpg', '/s/2.jpg'],
  ...extra,
})

describe('media: thumbs atlas', () => {
  it('rows default to columns (CONTRACT §3)', () => {
    expect(atlasRows(fixtures.thumbs)).toBe(fixtures.thumbs.columns)
    expect(tilesPerSprite(thumbs())).toBe(16)
    expect(tilesPerSprite(thumbs({ rows: 2 }))).toBe(8)
  })

  it('tile position respects rows when choosing the sprite', () => {
    const t = thumbs({ rows: 2 }) // 8 плиток на атлас
    // кадр 9 (src 4.5 с) → атлас 1, локальный 1 → столбец 1, строка 0
    expect(thumbTile(t, 4.5)).toEqual({ sprite: '/s/1.jpg', sx: 160, sy: 0, sw: 160, sh: 90 })
    // кадр 6 → атлас 0, столбец 2, строка 1
    expect(thumbTile(t, 3)).toEqual({ sprite: '/s/0.jpg', sx: 320, sy: 90, sw: 160, sh: 90 })
    // без rows — квадратный атлас: кадр 9 на первом атласе, строка 2
    expect(thumbTile(thumbs(), 4.5)).toEqual({ sprite: '/s/0.jpg', sx: 160, sy: 180, sw: 160, sh: 90 })
  })

  it('clamps to the first/last frame', () => {
    expect(thumbTile(thumbs(), -1)?.sx).toBe(0)
    // count 20 → последний кадр 19: атлас 2, локальный 3
    expect(thumbTile(thumbs({ rows: 2, count: 20 }), 1000)).toMatchObject({
      sprite: '/s/2.jpg',
      sx: 480,
      sy: 0,
    })
    // атласа для кадра нет (битый thumbs.json) — null, а не исключение
    expect(thumbTile(thumbs({ rows: 2 }), 1000)).toBeNull()
    expect(thumbTile(thumbs({ count: 0 }), 1)).toBeNull()
  })
})

describe('media: waveform', () => {
  it('fixture waveform uses 256 samples per peak', () => {
    expect(fixtures.waveform.samplesPerPeak).toBe(256)
    expect(fixtures.waveform.peaks.length % 2).toBe(0)
  })

  it('peak index = src · sampleRate / samplesPerPeak', () => {
    const w = fixtures.waveform
    const peaks = w.peaks.length / 2
    expect(peakIndex(w, 0)).toBe(0)
    expect(peakIndex(w, 1)).toBe(Math.floor(w.sampleRate / 256))
    expect(peakIndex(w, 1e6)).toBe(peaks - 1)
  })
})
