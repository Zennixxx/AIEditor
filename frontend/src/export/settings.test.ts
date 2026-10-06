import { describe, expect, it } from 'vitest'
import {
  defaultBitrateMbps,
  defaultExportSettings,
  exportRange,
  formatDuration,
  frameCount,
  frameTime,
  outputSize,
  sanitizeFileName,
} from './settings'

describe('outputSize', () => {
  it('keeps project size for "project"', () => {
    expect(outputSize({ width: 1920, height: 1080 }, 'project')).toEqual({ width: 1920, height: 1080 })
  })

  it('scales by the short side and keeps dimensions even', () => {
    expect(outputSize({ width: 1920, height: 1080 }, '720p')).toEqual({ width: 1280, height: 720 })
    expect(outputSize({ width: 1920, height: 1080 }, '4k')).toEqual({ width: 3840, height: 2160 })
    expect(outputSize({ width: 1080, height: 1920 }, '720p')).toEqual({ width: 720, height: 1280 })
    expect(outputSize({ width: 1001, height: 1001 }, 'project')).toEqual({ width: 1002, height: 1002 })
  })
})

describe('exportRange', () => {
  const p = { duration: 30 }

  it('covers the whole project for "all"', () => {
    expect(exportRange(p, 'all', 5, 10)).toEqual({ start: 0, end: 30 })
  })

  it('uses in/out points and falls back to project bounds', () => {
    expect(exportRange(p, 'inout', 5, 10)).toEqual({ start: 5, end: 10 })
    expect(exportRange(p, 'inout', 5, null)).toEqual({ start: 5, end: 30 })
    expect(exportRange(p, 'inout', null, 12)).toEqual({ start: 0, end: 12 })
  })
})

describe('frames', () => {
  it('counts frames without a trailing partial frame from rounding noise', () => {
    expect(frameCount({ start: 0, end: 1 }, 30)).toBe(30)
    expect(frameCount({ start: 2, end: 2.1 + 1e-9 }, 30)).toBe(3)
    expect(frameCount({ start: 0, end: 1.01 }, 30)).toBe(31)
    expect(frameCount({ start: 3, end: 3 }, 30)).toBe(0)
  })

  it('places frame i at start + i / fps', () => {
    expect(frameTime({ start: 2, end: 3 }, 25, 5)).toBeCloseTo(2.2, 12)
  })
})

describe('defaults', () => {
  it('scales bitrate with pixels and frame rate', () => {
    expect(defaultBitrateMbps(1920, 1080, 30)).toBe(16)
    expect(defaultBitrateMbps(1920, 1080, 60)).toBe(32)
    expect(defaultBitrateMbps(3840, 2160, 60)).toBe(128)
    expect(defaultBitrateMbps(320, 180, 15)).toBe(1)
  })

  it('sanitizes the file name', () => {
    expect(sanitizeFileName('Эдит: "дроп"')).toBe('Эдит дроп.mp4')
    expect(sanitizeFileName('clip.mp4')).toBe('clip.mp4')
    expect(sanitizeFileName('  ')).toBe('export.mp4')
    expect(sanitizeFileName('a/b', '.jsx')).toBe('ab.jsx')
  })

  it('selects in/out range when it is set', () => {
    const p = { name: 'Demo', fps: 30 as const, width: 1920, height: 1080 }
    expect(defaultExportSettings(p, true).range).toBe('inout')
    expect(defaultExportSettings(p, false)).toMatchObject({ range: 'all', fps: 30, fileName: 'Demo.mp4' })
  })

  it('formats durations', () => {
    expect(formatDuration(5)).toBe('0:05')
    expect(formatDuration(125)).toBe('2:05')
    expect(formatDuration(3725)).toBe('1:02:05')
  })
})
