import { describe, expect, it } from 'vitest'
import { fixtures } from '@/api/mocks/fixtures'
import { clip, sampleProject, track } from '@/model/testUtils'
import type { Clip, Project } from '@/shared/types.gen'
import {
  audibleTracks,
  clipAt,
  entrySource,
  layerAt,
  sourceRate,
  topVideoLayer,
  upcomingVideoClips,
  videoLayersAt,
} from './timing'

/** V1: a [0..2) b [2..4) (source 3..5); V2 (над V1): c [1..3) */
function layered(): Project {
  const p = sampleProject()
  p.tracks[1]!.items = [clip('clp_c', 1, 2, { sourceIn: 6, sourceOut: 8 })]
  return p
}

describe('playback timing: which clip, which source time', () => {
  it('clipAt uses half-open [start, end)', () => {
    const v1 = sampleProject().tracks[0]!
    expect(clipAt(v1, 0)?.id).toBe('clp_a')
    expect(clipAt(v1, 1.999)?.id).toBe('clp_a')
    expect(clipAt(v1, 2)?.id).toBe('clp_b')
    expect(clipAt(v1, 4)).toBeNull()
    expect(clipAt(v1, -0.1)).toBeNull()
  })

  it('top visible layer: upper track wins, hidden tracks are skipped', () => {
    const p = layered()
    expect(videoLayersAt(p, 1.5).map((l) => l.clip.id)).toEqual(['clp_c', 'clp_a'])
    expect(topVideoLayer(p, 1.5)?.clip.id).toBe('clp_c')
    expect(topVideoLayer(p, 3.5)?.clip.id).toBe('clp_b')
    p.tracks[1]!.hidden = true
    expect(topVideoLayer(p, 1.5)?.clip.id).toBe('clp_a')
    expect(topVideoLayer(p, 10)).toBeNull()
  })

  it('source time follows sourceIn / speed / reverse', () => {
    const p = layered()
    expect(topVideoLayer(p, 2.5)!.src).toBeCloseTo(7.5) // c: 6 + 1.5
    expect(topVideoLayer(p, 3.5)!.src).toBeCloseTo(4.5) // b: 3 + 1.5
    const fast = clip('clp_f', 10, 2, { sourceIn: 1, sourceOut: 5, speed: 2 })
    const rev = clip('clp_r', 10, 2, { sourceIn: 1, sourceOut: 3, reverse: true })
    const v = track('trk_x', 'video', [fast])
    expect(layerAt(v, fast, 10.5).src).toBeCloseTo(2)
    expect(layerAt(v, fast, 10.5).rate).toBe(2)
    expect(layerAt(v, rev, 10).src).toBeCloseTo(3)
    expect(layerAt(v, rev, 11.5).src).toBeCloseTo(1.5)
    expect(layerAt(v, rev, 11.5).rate).toBe(-1)
  })

  const { tolerance, vectors } = fixtures.timeRemapVectors

  it.each(vectors.map((v) => [v.name, v] as const))(
    'timeRemap clip matches reference vector %s at timeline times',
    (_name, v) => {
      const start = 12.5
      const c = clip('clp_ramp', start, v.D, {
        sourceIn: v.sourceIn,
        sourceOut: v.sourceOut,
        reverse: v.reverse,
        timeRemap: v.remap,
      })
      const tr = track('trk_r', 'video', [c])
      for (const s of v.samples) {
        expect(Math.abs(layerAt(tr, c, start + s.tau).src - s.src)).toBeLessThanOrEqual(tolerance)
      }
    },
  )

  it('sourceRate of a ramp is the derivative of src(τ)', () => {
    const v = vectors.find((x) => x.remap.keyframes.length > 2 && x.remap.fit === 'stretch')!
    const c = clip('clp_ramp', 0, v.D, {
      sourceIn: v.sourceIn,
      sourceOut: v.sourceOut,
      reverse: v.reverse,
      timeRemap: v.remap,
    })
    const tr = track('trk_r', 'video', [c])
    const h = 1e-4
    for (const tau of [0.1, 0.3, 0.5, 0.8].map((k) => k * v.D)) {
      const numeric = (layerAt(tr, c, tau + h).src - layerAt(tr, c, tau - h).src) / (2 * h)
      expect(sourceRate(c, tau)).toBeCloseTo(numeric, 2)
    }
  })

  it('upcoming clips within the preload horizon (forward and backward)', () => {
    const p = layered()
    expect(upcomingVideoClips(p, 0.5, 2).map((u) => u.clip.id)).toEqual(['clp_c', 'clp_b'])
    expect(upcomingVideoClips(p, 0.5, 1).map((u) => u.clip.id)).toEqual(['clp_c'])
    expect(upcomingVideoClips(p, 3.5, 2, -1).map((u) => u.clip.id)).toEqual(['clp_c', 'clp_a'])
    expect(upcomingVideoClips(p, 3.5, 1, -1).map((u) => u.clip.id)).toEqual(['clp_c'])
    expect(entrySource(p.tracks[0]!.items[1] as Clip)).toBeCloseTo(3)
  })

  it('audible tracks: muted dropped, solo keeps only soloed tracks', () => {
    const p = sampleProject()
    p.tracks.push(track('trk_a2', 'audio'))
    expect(audibleTracks(p, []).map((t) => t.id)).toEqual(['trk_v1', 'trk_v2', 'trk_a1', 'trk_a2'])
    p.tracks[3]!.muted = true
    expect(audibleTracks(p, []).map((t) => t.id)).toEqual(['trk_v1', 'trk_v2', 'trk_a2'])
    expect(audibleTracks(p, ['trk_a2']).map((t) => t.id)).toEqual(['trk_a2'])
    // solo на удалённой дорожке игнорируется
    expect(audibleTracks(p, ['trk_gone']).map((t) => t.id)).toEqual(['trk_v1', 'trk_v2', 'trk_a2'])
  })
})
