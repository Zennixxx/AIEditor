import {
  AudioBufferSource,
  BufferTarget,
  EncodedPacket,
  EncodedVideoPacketSource,
  Mp4OutputFormat,
  Output,
  StreamTarget,
} from 'mediabunny'
import type { AssetLookup } from '@/playback/timing'
import { buildFramePlan } from '@/render/framePlan'
import { Renderer } from '@/render/renderer'
import type { Project } from '@/shared/types.gen'
import { MIX_CHANNELS, MIX_RATE, renderMix, sliceBuffer } from './audioMix'
import { findEncoderConfig, mediabunnyQuality, pickAudioCodec, type AudioChoice } from './codecs'
import {
  CODEC_LABELS,
  frameCount,
  frameTime,
  outputSize,
  type ExportSettings,
  type TimeRange,
} from './settings'
import { ExportError, ExportFrames } from './sources'

export type ExportPhase = 'prepare' | 'audio' | 'video' | 'finalize'

export interface ExportProgress {
  phase: ExportPhase
  frame: number
  frames: number
  fraction: number
  elapsed: number
  eta: number | null
}

export type ExportDestination = { kind: 'file'; handle: FileSystemFileHandle } | { kind: 'buffer' }

export interface ExportJob {
  project: Project
  settings: ExportSettings
  range: TimeRange
  assets: AssetLookup
  destination: ExportDestination
  signal?: AbortSignal
  onProgress?: (p: ExportProgress) => void
}

export interface ExportResult {
  blob: Blob | null
  bytes: number
  frames: number
  width: number
  height: number
  codec: string
  audio: AudioChoice | null
  sources: Record<string, string>
  warnings: string[]
}

const MAX_ENCODE_QUEUE = 8
const AUDIO_CHUNK_SEC = 1
const AUDIO_LEAD_SEC = 1
const KEYFRAME_SEC = 2
const PRIME_FRAMES = 12

function waitDequeue(encoder: VideoEncoder): Promise<void> {
  return new Promise((resolve) => {
    const done = () => resolve()
    encoder.addEventListener('dequeue', done, { once: true })
    setTimeout(done, 20)
  })
}

async function primeEncoder(encoder: VideoEncoder, frame: VideoFrame, step: number): Promise<void> {
  for (let k = 0; k < PRIME_FRAMES; k++) {
    const copy = new VideoFrame(frame, { timestamp: k * step, duration: step })
    while (encoder.encodeQueueSize > MAX_ENCODE_QUEUE) await waitDequeue(encoder)
    encoder.encode(copy, { keyFrame: k === 0 })
    copy.close()
  }
}

async function discardFile(handle: FileSystemFileHandle): Promise<void> {
  const removable = handle as FileSystemFileHandle & { remove?: () => Promise<void> }
  try {
    if (removable.remove) await removable.remove()
    else await (await handle.createWritable()).close()
  } catch {
    return
  }
}

export async function exportVideo(job: ExportJob): Promise<ExportResult> {
  const { project, settings, range, assets, destination, signal } = job
  const { width, height } = outputSize(project, settings.resolution)
  const fps = settings.fps
  const frames = frameCount(range, fps)
  if (frames === 0) throw new ExportError('Пустой диапазон экспорта')
  const warnings: string[] = []
  const started = performance.now()
  const report = (phase: ExportPhase, frame: number, fraction: number) => {
    const elapsed = (performance.now() - started) / 1000
    const eta = phase === 'video' && fraction > 0.01 ? (elapsed * (1 - fraction)) / fraction : null
    job.onProgress?.({ phase, frame, frames, fraction, elapsed, eta })
  }

  report('prepare', 0, 0)
  const config = await findEncoderConfig(settings.codec, {
    width,
    height,
    fps,
    bitrate: Math.round(settings.bitrateMbps * 1e6),
    bitrateMode: settings.bitrateMode,
  })
  if (!config)
    throw new ExportError(`${CODEC_LABELS[settings.codec]} ${width}×${height} не поддерживается браузером`)

  report('audio', 0, 0)
  const mix = await renderMix(project, range, assets, signal)
  signal?.throwIfAborted()
  const audio = mix ? await pickAudioCodec(MIX_RATE, MIX_CHANNELS) : null
  if (mix && !audio) warnings.push('Браузер не кодирует AAC/Opus — файл без звука')

  const writable = destination.kind === 'file' ? await destination.handle.createWritable() : null
  const bufferTarget = writable ? null : new BufferTarget()
  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: writable ? false : 'in-memory' }),
    target: writable ? new StreamTarget(writable) : bufferTarget!,
  })
  const videoSource = new EncodedVideoPacketSource(settings.codec)
  output.addVideoTrack(videoSource, { frameRate: fps })
  const audioSource =
    mix && audio
      ? new AudioBufferSource({ codec: audio.codec, quality: mediabunnyQuality(audio.bitrate) })
      : null
  if (audioSource) output.addAudioTrack(audioSource)

  const canvas = new OffscreenCanvas(width, height)
  let renderer: Renderer | null = null
  const sources = new ExportFrames(assets)
  let encoder: VideoEncoder | null = null
  let finished = false
  try {
    renderer = new Renderer(canvas, { preserveDrawingBuffer: true })
    renderer.warmUp()
    await output.start()

    let encodeError: unknown = null
    let packets: Promise<void> = Promise.resolve()
    let primedConfig: VideoDecoderConfig | undefined
    let firstPacket = true
    const step = Math.round(1e6 / fps)
    const primeUs = PRIME_FRAMES * step
    encoder = new VideoEncoder({
      output: (chunk, meta) => {
        if (chunk.timestamp < primeUs) {
          primedConfig = meta?.decoderConfig ?? primedConfig
          return
        }
        const withConfig =
          firstPacket && !meta?.decoderConfig && primedConfig
            ? { ...meta, decoderConfig: primedConfig }
            : meta
        firstPacket = false
        const raw = EncodedPacket.fromEncodedChunk(chunk)
        const packet = raw.clone({ timestamp: (chunk.timestamp - primeUs) / 1e6 })
        packets = packets.then(() => videoSource.add(packet, withConfig))
      },
      error: (e) => {
        encodeError = e
      },
    })
    encoder.configure(config)

    let audioPos = 0
    const pushAudio = async (until: number) => {
      if (!audioSource || !mix) return
      const limit = Math.min(mix.length, Math.ceil(until * MIX_RATE))
      while (audioPos < limit) {
        const n = Math.min(AUDIO_CHUNK_SEC * MIX_RATE, mix.length - audioPos)
        await audioSource.add(sliceBuffer(mix, audioPos, n))
        audioPos += n
      }
    }

    const gop = Math.max(1, Math.round(fps * KEYFRAME_SEC))
    const r = renderer
    for (let i = 0; i < frames; i++) {
      signal?.throwIfAborted()
      if (encodeError) throw encodeError
      const plan = buildFramePlan(project, frameTime(range, fps, i))
      const images = await sources.load(plan)
      r.render(plan, (step) => images.get(step.clip.id) ?? null)
      sources.release()
      const frame = new VideoFrame(canvas, {
        timestamp: primeUs + Math.round((i * 1e6) / fps),
        duration: step,
      })
      if (i === 0) await primeEncoder(encoder, frame, step)
      while (encoder.encodeQueueSize > MAX_ENCODE_QUEUE) await waitDequeue(encoder)
      encoder.encode(frame, { keyFrame: i % gop === 0 })
      frame.close()
      await pushAudio((i + 1) / fps + AUDIO_LEAD_SEC)
      await packets
      report('video', i + 1, (i + 1) / frames)
    }
    await encoder.flush()
    await packets
    if (encodeError) throw encodeError
    encoder.close()
    encoder = null
    await pushAudio(Infinity)
    videoSource.close()
    audioSource?.close()
    report('finalize', frames, 1)
    await output.finalize()
    finished = true

    const blob = bufferTarget?.buffer ? new Blob([bufferTarget.buffer], { type: 'video/mp4' }) : null
    const bytes = blob?.size ?? (destination.kind === 'file' ? (await destination.handle.getFile()).size : 0)
    return {
      blob,
      bytes,
      frames,
      width,
      height,
      codec: config.codec,
      audio,
      sources: Object.fromEntries(sources.used),
      warnings,
    }
  } finally {
    if (encoder && encoder.state !== 'closed') encoder.close()
    await sources.dispose()
    renderer?.dispose()
    if (!finished) {
      await output.cancel().catch(() => undefined)
      if (destination.kind === 'file') await discardFile(destination.handle)
    }
  }
}
