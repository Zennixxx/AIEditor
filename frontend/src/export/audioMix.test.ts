import { describe, expect, it } from 'vitest'
import { audioAsset, clip, track, videoAsset } from '@/model/testUtils'
import type { Asset, Project } from '@/shared/types.gen'
import { planMix } from './audioMix'
import { videoCandidates } from './sourceUrls'

const music: Asset = { ...audioAsset, derived: { audio: '/api/assets/ast_audio0000000001/audio.m4a' } }
const lookup = (id: string) => (id === music.id ? music : undefined)

function project(tracks: Project['tracks']): Pick<Project, 'tracks'> {
  return { tracks }
}

describe('planMix', () => {
  it('shifts voices to the export range and trims the start', () => {
    const p = project([
      track('trk_a', 'audio', [clip('clp_m', 1, 10, { assetId: music.id })], { volume: 0.5 }),
    ])
    const [v] = planMix(p, { start: 3, end: 6 }, lookup)
    expect(v).toMatchObject({ clipId: 'clp_m', when: 0, src: 2, reverse: false, rate: 1, gain: 0.5 })
    expect(v!.duration).toBeCloseTo(8, 9)
  })

  it('ignores muted tracks and session solo, skips clips outside the range', () => {
    const p = project([
      track('trk_a', 'audio', [clip('clp_m', 0, 2, { assetId: music.id })], { muted: true }),
      track('trk_b', 'audio', [
        clip('clp_x', 0, 1, { assetId: music.id }),
        clip('clp_y', 4, 2, { assetId: music.id }),
      ]),
    ])
    const voices = planMix(p, { start: 1.5, end: 5 }, lookup)
    expect(voices.map((v) => v.clipId)).toEqual(['clp_y'])
    expect(voices[0]!.when).toBeCloseTo(2.5, 9)
  })

  it('returns nothing for an empty range', () => {
    const p = project([track('trk_a', 'audio', [clip('clp_m', 0, 2, { assetId: music.id })])])
    expect(planMix(p, { start: 1, end: 1 }, lookup)).toEqual([])
  })
})

describe('videoCandidates', () => {
  const proxy = '/api/assets/ast_video0000000001/proxy.mp4'
  const mezz = '/api/assets/ast_video0000000001/mezzanine.mp4'

  it('prefers the original for browser-decodable assets', () => {
    const a: Asset = { ...videoAsset, derived: { proxy } }
    expect(videoCandidates({}, a, () => undefined)).toEqual([
      '/api/assets/ast_video0000000001/original',
      proxy,
    ])
  })

  it('prefers the mezzanine when the original is not decodable', () => {
    const a: Asset = { ...videoAsset, browserDecodable: false, derived: { proxy, mezzanine: mezz } }
    expect(videoCandidates({}, a, () => undefined)).toEqual([
      mezz,
      '/api/assets/ast_video0000000001/original',
      proxy,
    ])
  })

  it('puts a ready interpolated asset first', () => {
    const a: Asset = { ...videoAsset, derived: { proxy } }
    const interp: Asset = { ...videoAsset, id: 'ast_interp00000001', status: 'ready' }
    const urls = videoCandidates({ interpolatedAssetId: interp.id }, a, (id) =>
      id === interp.id ? interp : undefined,
    )
    expect(urls[0]).toBe('/api/assets/ast_interp00000001/original')
    const pending = { ...interp, status: 'importing' as const }
    expect(videoCandidates({ interpolatedAssetId: interp.id }, a, () => pending)[0]).toBe(
      '/api/assets/ast_video0000000001/original',
    )
  })
})
