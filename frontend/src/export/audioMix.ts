import { assetsApi } from '@/api/assets'
import { applyParam, reverseBuffer } from '@/playback/audioEngine'
import { bufferOffset, planAudio } from '@/playback/audioPlan'
import type { AssetLookup } from '@/playback/timing'
import type { Project } from '@/shared/types.gen'
import type { TimeRange } from './settings'

export const MIX_RATE = 48000
export const MIX_CHANNELS = 2

export interface MixVoice {
  clipId: string
  url: string
  when: number
  duration: number
  src: number
  reverse: boolean
  rate: number | number[]
  gain: number | number[]
}

export function planMix(project: Pick<Project, 'tracks'>, range: TimeRange, assets: AssetLookup): MixVoice[] {
  if (range.end <= range.start) return []
  const segments = planAudio(project, range.start, { assets, solo: [], until: range.end })
  const voices: MixVoice[] = []
  for (const seg of segments) {
    const url = assets(seg.assetId)?.derived.audio
    if (!url) continue
    voices.push({
      clipId: seg.clipId,
      url,
      when: seg.start - range.start,
      duration: seg.end - seg.start,
      src: seg.src,
      reverse: seg.reverse,
      rate: seg.rate,
      gain: seg.gain,
    })
  }
  return voices
}

export async function renderMix(
  project: Pick<Project, 'tracks'>,
  range: TimeRange,
  assets: AssetLookup,
  signal?: AbortSignal,
): Promise<AudioBuffer | null> {
  const voices = planMix(project, range, assets)
  if (voices.length === 0) return null
  const length = Math.max(1, Math.ceil((range.end - range.start) * MIX_RATE))
  const ctx = new OfflineAudioContext(MIX_CHANNELS, length, MIX_RATE)
  const decoded = new Map<string, Promise<AudioBuffer>>()
  const reversed = new Map<string, AudioBuffer>()
  const load = (url: string) => {
    let p = decoded.get(url)
    if (!p) {
      p = fetch(assetsApi.fileUrl(url), { signal })
        .then((r) => {
          if (!r.ok) throw new Error(`Звук ${url}: HTTP ${r.status}`)
          return r.arrayBuffer()
        })
        .then((data) => ctx.decodeAudioData(data))
      decoded.set(url, p)
    }
    return p
  }
  for (const v of voices) {
    let buffer = await load(v.url)
    signal?.throwIfAborted()
    if (v.reverse) {
      let r = reversed.get(v.url)
      if (!r) {
        r = reverseBuffer(ctx, buffer)
        reversed.set(v.url, r)
      }
      buffer = r
    }
    const offset = bufferOffset(v.src, v.reverse, buffer.duration)
    if (offset >= buffer.duration - 1e-3 || v.duration <= 1e-3) continue
    const node = ctx.createBufferSource()
    node.buffer = buffer
    const gain = ctx.createGain()
    node.connect(gain).connect(ctx.destination)
    applyParam(node.playbackRate, v.rate, 1, v.when, v.duration)
    applyParam(gain.gain, v.gain, 1, v.when, v.duration)
    node.start(v.when, offset)
    node.stop(v.when + v.duration)
  }
  return ctx.startRendering()
}

export function sliceBuffer(buffer: AudioBuffer, from: number, frames: number): AudioBuffer {
  const n = Math.max(0, Math.min(frames, buffer.length - from))
  const out = new AudioBuffer({
    length: Math.max(1, n),
    numberOfChannels: buffer.numberOfChannels,
    sampleRate: buffer.sampleRate,
  })
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    out.copyToChannel(buffer.getChannelData(c).subarray(from, from + n), c)
  }
  return out
}
