import { describe, expect, it } from 'vitest'
import { audioAsset, clip, sampleProject, track, videoAsset } from '@/model/testUtils'
import type { Asset, Project } from '@/shared/types.gen'
import { bufferOffset, CURVE_RATE, planAudio, sampleCurve } from './audioPlan'

const withAudio = (a: Asset): Asset => ({ ...a, derived: { audio: `/api/assets/${a.id}/audio.m4a` } })
const lib = [withAudio(videoAsset), withAudio(audioAsset)]
const assets = (id: string) => lib.find((a) => a.id === id)

/** sampleProject + A1: музыка [0..8) с громкостью дорожки 0.5 */
function project(): Project {
  const p = sampleProject()
  const music = clip('clp_m', 0, 8, { assetId: audioAsset.id, sourceIn: 10, sourceOut: 18, volume: 0.8 })
  p.tracks[3] = track('trk_a1', 'audio', [music], { volume: 0.5 })
  return p
}

describe('audio plan', () => {
  it('segments start at the playhead with the matching source offset', () => {
    const segs = planAudio(project(), 1, { assets, solo: [] })
    // по времени начала; при равном — в порядке дорожек снизу вверх
    expect(segs.map((s) => s.clipId)).toEqual(['clp_a', 'clp_m', 'clp_b'])
    const music = segs.find((s) => s.clipId === 'clp_m')!
    expect(music).toMatchObject({ start: 1, end: 8, src: 11, reverse: false, rate: 1 })
    expect(music.gain).toBeCloseTo(0.4) // дорожка 0.5 × клип 0.8
    const b = segs.find((s) => s.clipId === 'clp_b')!
    expect(b).toMatchObject({ start: 2, end: 4, src: 3 })
  })

  it('finished clips and clips beyond the window are skipped', () => {
    expect(planAudio(project(), 2.5, { assets, solo: [] }).map((s) => s.clipId)).toEqual(['clp_b', 'clp_m'])
    expect(planAudio(project(), 0, { assets, solo: [], until: 1.5 }).map((s) => s.clipId)).toEqual([
      'clp_a',
      'clp_m',
    ])
  })

  it('mute and solo', () => {
    const p = project()
    p.tracks[0]!.muted = true
    expect(planAudio(p, 0, { assets, solo: [] }).map((s) => s.clipId)).toEqual(['clp_m'])
    p.tracks[0]!.muted = false
    expect(planAudio(p, 0, { assets, solo: ['trk_a1'] }).map((s) => s.clipId)).toEqual(['clp_m'])
    p.tracks[3]!.muted = true
    expect(planAudio(p, 0, { assets, solo: [] }).map((s) => s.clipId)).toEqual(['clp_a', 'clp_b'])
  })

  it('assets without sound or audio.m4a are silent', () => {
    const silent = (id: string) => {
      const a = assets(id)
      return a && a.kind === 'video' ? { ...a, hasAudio: false } : a
    }
    expect(planAudio(project(), 0, { assets: silent, solo: [] }).map((s) => s.clipId)).toEqual(['clp_m'])
    const noFile = (id: string) => (id === audioAsset.id ? audioAsset : assets(id))
    expect(planAudio(project(), 0, { assets: noFile, solo: [] }).map((s) => s.clipId)).toEqual([
      'clp_a',
      'clp_b',
    ])
  })

  it('speed and reverse: playback rate and offset in the reversed buffer', () => {
    const p = project()
    p.tracks[3]!.items = [
      clip('clp_fast', 0, 4, { assetId: audioAsset.id, sourceIn: 0, sourceOut: 8, speed: 2 }),
      clip('clp_rev', 4, 2, { assetId: audioAsset.id, sourceIn: 20, sourceOut: 22, reverse: true }),
    ]
    const segs = planAudio(p, 1, { assets, solo: ['trk_a1'] })
    expect(segs[0]).toMatchObject({ clipId: 'clp_fast', rate: 2, src: 2 })
    expect(segs[1]).toMatchObject({ clipId: 'clp_rev', rate: 1, src: 22, reverse: true })
    // развёрнутый буфер длиной 60 с: source 22 → позиция 38
    expect(bufferOffset(22, true, 60)).toBe(38)
    expect(bufferOffset(22, false, 60)).toBe(22)
    expect(bufferOffset(70, false, 60)).toBe(60)
  })

  it('timeRemap and volume keyframes become curves over the segment', () => {
    const p = project()
    p.tracks[3]!.items = [
      clip('clp_ramp', 0, 2, {
        assetId: audioAsset.id,
        sourceIn: 0,
        sourceOut: 3,
        timeRemap: {
          keyframes: [
            { u: 0, speed: 1, ease: 'linear' },
            { u: 1, speed: 2, ease: 'linear' },
          ],
          fit: 'stretch',
          frameBlend: false,
        },
        volume: [
          { t: 0, v: 0, ease: 'linear' },
          { t: 2, v: 1, ease: 'linear' },
        ],
      }),
    ]
    const [seg] = planAudio(p, 0, { assets, solo: ['trk_a1'] })
    const rate = seg!.rate as number[]
    expect(rate).toHaveLength(2 * CURVE_RATE + 1)
    // S(1) = 1.5, k = 3 / (2 · 1.5) = 1 → скорость 1 → 2
    expect(rate[0]).toBeCloseTo(1)
    expect(rate[rate.length - 1]).toBeCloseTo(2)
    const gain = seg!.gain as number[]
    expect(gain[0]).toBeCloseTo(0)
    expect(gain[gain.length - 1]).toBeCloseTo(0.5) // × громкость дорожки
  })

  it('sampleCurve covers the range with ≥ 2 points', () => {
    expect(sampleCurve(0, 0, () => 1)).toHaveLength(2)
    const c = sampleCurve(1, 2, (x) => x)
    expect(c[0]).toBe(1)
    expect(c[c.length - 1]).toBe(2)
  })
})
