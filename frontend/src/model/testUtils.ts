// Помощники для unit-тестов model/ (не входят в бандл приложения).
import type { Asset, Clip, Project, Track } from '@/shared/types.gen'
import type { IdPrefix } from '@/shared/ids'
import { clipFromAsset } from './project'

export function seqIds(): (prefix: IdPrefix) => string {
  let n = 0
  return (prefix) => `${prefix}_t${String(++n).padStart(8, '0')}`
}

export const videoAsset: Asset = {
  id: 'ast_video0000000001',
  kind: 'video',
  name: 'a.mp4',
  path: 'D:\\a.mp4',
  duration: 10,
  width: 1920,
  height: 1080,
  fps: 30,
  hasAudio: true,
  codec: 'h264',
  browserDecodable: true,
  status: 'ready',
  derived: {},
}

export const audioAsset: Asset = {
  ...videoAsset,
  id: 'ast_audio0000000001',
  kind: 'audio',
  name: 'm.mp3',
  duration: 60,
  codec: 'mp3',
}

export function clip(id: string, start: number, duration: number, extra: Partial<Clip> = {}): Clip {
  const base = clipFromAsset(videoAsset, start, 30)
  return { ...base, id, start, duration, sourceIn: 0, sourceOut: duration, ...extra }
}

export function track(
  id: string,
  kind: Track['kind'],
  items: Track['items'] = [],
  extra: Partial<Track> = {},
): Track {
  return { id, kind, name: id, muted: false, locked: false, hidden: false, items, ...extra }
}

/** V1: [0..2) [2..4), V2: [], A1: [], FX: [fx 1..1.5) */
export function sampleProject(): Project {
  return {
    schemaVersion: 1,
    id: 'prj_test000001',
    name: 'test',
    fps: 30,
    width: 1920,
    height: 1080,
    duration: 4,
    background: '#000000',
    assets: [structuredClone(videoAsset), structuredClone(audioAsset)],
    tracks: [
      track('trk_v1', 'video', [clip('clp_a', 0, 2), clip('clp_b', 2, 2, { sourceIn: 3, sourceOut: 5 })]),
      track('trk_v2', 'video'),
      track('trk_fx', 'fx', [
        {
          id: 'fx_shake',
          type: 'effect',
          effect: 'shake',
          start: 1,
          duration: 0.5,
          params: {},
          envelope: { attack: 0, hold: 0, decay: 0.5, curve: 'linear' },
          enabled: true,
        },
      ]),
      track('trk_a1', 'audio'),
    ],
    markers: [],
    sections: [],
    createdAt: '2026-10-05T00:00:00Z',
    updatedAt: '2026-10-05T00:00:00Z',
    revision: 0,
  }
}
