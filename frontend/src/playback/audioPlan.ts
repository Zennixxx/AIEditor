// План аудио от мастер-часов: какие куски каких клипов звучат начиная с timeline time `from`.
// Чистые функции — audioEngine превращает сегменты в AudioBufferSourceNode.
import { EPS, itemEnd } from '@/model/clipTime'
import { evaluateAnimatable } from '@/model/keyframes'
import { isClip } from '@/model/lookup'
import type { Clip, Project, Track } from '@/shared/types.gen'
import { audibleTracks, clipHasSound, layerAt, sourceRate, type AssetLookup } from './timing'

/** Точек на секунду в кривых скорости/громкости (setValueCurveAtTime). */
export const CURVE_RATE = 60
const MAX_CURVE_POINTS = 4096

export interface AudioSegment {
  /** Ключ для планировщика: один сегмент на клип за проход. */
  clipId: string
  trackId: string
  assetId: string
  /** Начало звучания, timeline time (≥ from). */
  start: number
  /** Конец, timeline time. */
  end: number
  /** Source time в момент `start`. */
  src: number
  /** Читать исходник задом наперёд (по развёрнутому буферу). */
  reverse: boolean
  /** |d(src)/d(t)| — playbackRate при скорости транспорта 1: число или кривая на [start, end]. */
  rate: number | number[]
  /** Громкость дорожки × громкость клипа: число или кривая на [start, end]. */
  gain: number | number[]
}

export interface AudioPlanOptions {
  assets: AssetLookup
  solo: readonly string[]
  /** Планировать только сегменты, начинающиеся раньше `until` (окно планировщика). */
  until?: number
}

export function planAudio(p: Pick<Project, 'tracks'>, from: number, opts: AudioPlanOptions): AudioSegment[] {
  const res: AudioSegment[] = []
  const until = opts.until ?? Infinity
  for (const track of audibleTracks(p, opts.solo)) {
    const trackGain = track.kind === 'audio' ? (track.volume ?? 1) : 1
    for (const item of track.items) {
      if (!isClip(item)) continue
      const end = itemEnd(item)
      if (end <= from + EPS || item.start >= until) continue
      const asset = opts.assets(item.assetId)
      if (!clipHasSound(asset)) continue
      const seg = segmentFor(track, item, Math.max(from, item.start), end, trackGain)
      if (seg) res.push(seg)
    }
  }
  return res.sort((a, b) => a.start - b.start)
}

function segmentFor(
  track: Track,
  clip: Clip,
  start: number,
  end: number,
  trackGain: number,
): AudioSegment | null {
  if (end - start <= EPS) return null
  const layer = layerAt(track, clip, start)
  const tau0 = start - clip.start
  const rate = clip.timeRemap
    ? sampleCurve(tau0, end - clip.start, (tau) => Math.abs(sourceRate(clip, tau)))
    : Math.abs(clip.speed)
  const volume = clip.volume ?? 1
  const gain =
    typeof volume === 'number'
      ? trackGain * volume
      : sampleCurve(tau0, end - clip.start, (tau) => trackGain * evaluateAnimatable(volume, tau))
  return {
    clipId: clip.id,
    trackId: track.id,
    assetId: clip.assetId,
    start,
    end,
    src: layer.src,
    reverse: clip.reverse,
    rate,
    gain,
  }
}

/** Значения f(τ) на [τ0, τ1] с шагом 1/CURVE_RATE (минимум 2 точки) — для AudioParam.setValueCurveAtTime. */
export function sampleCurve(tau0: number, tau1: number, f: (tau: number) => number): number[] {
  const n = Math.min(MAX_CURVE_POINTS, Math.max(2, Math.ceil((tau1 - tau0) * CURVE_RATE) + 1))
  const out: number[] = []
  for (let i = 0; i < n; i++) out.push(f(tau0 + ((tau1 - tau0) * i) / (n - 1)))
  return out
}

/**
 * Позиция в буфере (сек) для source time `src`: прямой буфер — `src`,
 * развёрнутый (для reverse) — `bufferDuration − src`.
 */
export function bufferOffset(src: number, reverse: boolean, bufferDuration: number): number {
  const pos = reverse ? bufferDuration - src : src
  return Math.min(Math.max(pos, 0), bufferDuration)
}
