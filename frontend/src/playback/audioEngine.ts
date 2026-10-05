// Звук: audio.m4a ассетов декодируется в AudioBuffer (кэш), сегменты из audioPlan планируются
// AudioBufferSourceNode-ами в шкале AudioContext.currentTime — той же, что у мастер-часов.
import { assetsApi } from '@/api/assets'
import type { Project } from '@/shared/types.gen'
import { bufferOffset, planAudio, type AudioSegment } from './audioPlan'
import { clipHasSound, type AssetLookup } from './timing'

/** Окно планирования: сегменты, начинающиеся в ближайшие N секунд таймлайна. */
export const SCHEDULE_AHEAD = 2

type BufferEntry =
  | { status: 'loading' }
  | { status: 'ready'; buffer: AudioBuffer; reversed?: AudioBuffer }
  | { status: 'error' }

interface Voice {
  node: AudioBufferSourceNode
  gain: GainNode
}

export interface AudioPlayback {
  project: Pick<Project, 'tracks'>
  /** Timeline time в момент `now` (показание AudioContext). */
  t: number
  now: number
  /** Скорость транспорта; звук есть только при движении вперёд. */
  rate: number
  solo: readonly string[]
  assets: AssetLookup
}

export class AudioEngine {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  private buffers = new Map<string, BufferEntry>()
  /** clipId → голос; запланированный клип не перепланируется до restart(). */
  private voices = new Map<string, Voice | null>()
  private loadListeners = new Set<() => void>()

  /** AudioContext создаётся лениво; null — Web Audio недоступен (тесты/jsdom). */
  context(): AudioContext | null {
    if (this.ctx) return this.ctx
    const Ctor = globalThis.AudioContext as typeof AudioContext | undefined
    if (!Ctor) return null
    this.ctx = new Ctor({ latencyHint: 'interactive' })
    this.master = this.ctx.createGain()
    this.master.connect(this.ctx.destination)
    return this.ctx
  }

  /** Время контекста, если он запущен (иначе часы идут по performance.now()). */
  runningTime(): number | null {
    return this.ctx && this.ctx.state === 'running' ? this.ctx.currentTime : null
  }

  /** Запуск контекста по жесту пользователя (Space/кнопка Play). */
  resume(): Promise<void> {
    const ctx = this.context()
    if (!ctx || ctx.state === 'running') return Promise.resolve()
    return ctx.resume().catch(() => undefined)
  }

  onBufferLoaded(fn: () => void): () => void {
    this.loadListeners.add(fn)
    return () => this.loadListeners.delete(fn)
  }

  /** Заранее декодировать звук всех слышимых клипов проекта. */
  preload(project: Pick<Project, 'tracks'>, assets: AssetLookup): void {
    for (const track of project.tracks) {
      for (const item of track.items) {
        if (item.type !== 'clip') continue
        const a = assets(item.assetId)
        if (clipHasSound(a) && a?.derived.audio) this.load(a.derived.audio)
      }
    }
  }

  private load(url: string): BufferEntry | null {
    const existing = this.buffers.get(url)
    if (existing) return existing
    const ctx = this.context()
    if (!ctx) return null
    const entry: BufferEntry = { status: 'loading' }
    this.buffers.set(url, entry)
    fetch(assetsApi.fileUrl(url))
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.arrayBuffer()
      })
      .then((data) => ctx.decodeAudioData(data))
      .then(
        (buffer) => {
          this.buffers.set(url, { status: 'ready', buffer })
          this.loadListeners.forEach((fn) => fn())
        },
        () => this.buffers.set(url, { status: 'error' }),
      )
    return entry
  }

  private buffer(url: string, reverse: boolean): AudioBuffer | null {
    const e = this.load(url)
    if (!e || e.status !== 'ready') return null
    if (!reverse) return e.buffer
    e.reversed ??= reverseBuffer(this.ctx!, e.buffer)
    return e.reversed
  }

  /** Планирует сегменты окна [t, t + SCHEDULE_AHEAD·rate], ещё не запланированные. */
  tick(p: AudioPlayback): void {
    const ctx = this.ctx
    if (!ctx || ctx.state !== 'running' || !this.master || p.rate <= 0) return
    const segments = planAudio(p.project, p.t, {
      assets: p.assets,
      solo: p.solo,
      until: p.t + SCHEDULE_AHEAD * p.rate,
    })
    for (const seg of segments) {
      if (this.voices.has(seg.clipId)) continue
      const url = p.assets(seg.assetId)?.derived.audio
      if (!url) continue
      const buffer = this.buffer(url, seg.reverse)
      if (!buffer) continue // догрузится — подхватим на следующем тике с актуальным смещением
      this.voices.set(seg.clipId, this.schedule(ctx, buffer, seg, p))
    }
  }

  private schedule(
    ctx: AudioContext,
    buffer: AudioBuffer,
    seg: AudioSegment,
    p: AudioPlayback,
  ): Voice | null {
    const when = p.now + (seg.start - p.t) / p.rate
    const duration = (seg.end - seg.start) / p.rate
    const startAt = Math.max(ctx.currentTime, when)
    // если опоздали (when в прошлом) — сдвигаем точку входа в сегмент
    const late = Math.max(0, startAt - when)
    const offset = bufferOffset(seg.src, seg.reverse, buffer.duration)
    if (offset >= buffer.duration - 1e-3 || duration - late <= 1e-3) return null

    const node = ctx.createBufferSource()
    node.buffer = buffer
    const gain = ctx.createGain()
    node.connect(gain).connect(this.master!)
    applyParam(node.playbackRate, seg.rate, p.rate, when, duration)
    applyParam(gain.gain, seg.gain, 1, when, duration)
    const lateSrc = late * p.rate * (typeof seg.rate === 'number' ? seg.rate : (seg.rate[0] ?? 1))
    node.start(startAt, Math.min(buffer.duration, offset + lateSrc))
    node.stop(when + duration)
    const voice = { node, gain }
    node.onended = () => {
      node.disconnect()
      gain.disconnect()
    }
    return voice
  }

  /** Остановить всё запланированное (пауза, seek, правка проекта во время воспроизведения). */
  stopAll(): void {
    for (const v of this.voices.values()) {
      if (!v) continue
      try {
        v.node.stop()
      } catch {
        // уже остановлен
      }
      v.node.disconnect()
      v.gain.disconnect()
    }
    this.voices.clear()
  }

  dispose(): void {
    this.stopAll()
    void this.ctx?.close()
    this.ctx = null
    this.master = null
    this.buffers.clear()
    this.loadListeners.clear()
  }
}

/** Число или кривая (на длительность сегмента) → AudioParam; `scale` — множитель (скорость транспорта). */
function applyParam(
  param: AudioParam,
  value: number | number[],
  scale: number,
  when: number,
  duration: number,
): void {
  if (typeof value === 'number') {
    param.value = value * scale
    return
  }
  const curve = Float32Array.from(value, (v) => v * scale)
  param.value = curve[0] ?? 1
  if (curve.length >= 2 && duration > 0) param.setValueCurveAtTime(curve, when, duration)
}

function reverseBuffer(ctx: BaseAudioContext, src: AudioBuffer): AudioBuffer {
  const out = ctx.createBuffer(src.numberOfChannels, src.length, src.sampleRate)
  for (let c = 0; c < src.numberOfChannels; c++) {
    const data = src.getChannelData(c)
    const dst = out.getChannelData(c)
    for (let i = 0, n = data.length; i < n; i++) dst[i] = data[n - 1 - i]!
  }
  return out
}
