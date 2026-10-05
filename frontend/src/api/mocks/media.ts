// Синтетические медиа для MSW-моков: проигрываемый proxy.mp4 (кодируется в браузере через Mediabunny +
// WebCodecs), audio.m4a (на деле WAV — decodeAudioData его понимает), waveform.json по тому же звуку.
// Всё детерминировано от ID ассета, чтобы превью/звук/waveform совпадали между собой.
import type { Waveform } from '@/shared/types.gen'

export const MOCK_SAMPLE_RATE = 22050
export const MOCK_SAMPLES_PER_PEAK = 256 // как у бэка (CONTRACT v1.2)
export const MOCK_BPM = 120

function hashOf(s: string): number {
  let h = 0
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return h
}

/** Моно-трек: бочка на каждую долю, хэт на слабые, тихий бас-тон. Амплитуда ≤ 0.8. */
export function synthAudio(seed: string, duration: number, sampleRate = MOCK_SAMPLE_RATE): Float32Array {
  const n = Math.max(1, Math.round(duration * sampleRate))
  const out = new Float32Array(n)
  const beat = 60 / MOCK_BPM
  const baseHz = 55 * 2 ** ((hashOf(seed) % 5) / 12)
  let rng = hashOf(seed) || 1
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate
    const inBeat = t % beat
    const kick = Math.exp(-inBeat * 18) * Math.sin(2 * Math.PI * (50 + 90 * Math.exp(-inBeat * 30)) * inBeat)
    rng = (rng * 1664525 + 1013904223) >>> 0
    const noise = rng / 2 ** 32 - 0.5
    const off = (t + beat / 2) % beat
    const hat = Math.exp(-off * 60) * noise
    const tone = 0.15 * Math.sin(2 * Math.PI * baseHz * t)
    out[i] = 0.55 * kick + 0.25 * hat + tone
  }
  return out
}

/** PCM 16-bit mono WAV. */
export function encodeWav(samples: Float32Array, sampleRate = MOCK_SAMPLE_RATE): ArrayBuffer {
  const buf = new ArrayBuffer(44 + samples.length * 2)
  const v = new DataView(buf)
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)))
  str(0, 'RIFF')
  v.setUint32(4, 36 + samples.length * 2, true)
  str(8, 'WAVE')
  str(12, 'fmt ')
  v.setUint32(16, 16, true)
  v.setUint16(20, 1, true) // PCM
  v.setUint16(22, 1, true) // mono
  v.setUint32(24, sampleRate, true)
  v.setUint32(28, sampleRate * 2, true)
  v.setUint16(32, 2, true)
  v.setUint16(34, 16, true)
  str(36, 'data')
  v.setUint32(40, samples.length * 2, true)
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!))
    v.setInt16(44 + i * 2, Math.round(s * 32767), true)
  }
  return buf
}

/** Пики waveform (CONTRACT §3): пары [min, max] int8 на каждые samplesPerPeak сэмплов. */
export function waveformOf(
  samples: Float32Array,
  sampleRate = MOCK_SAMPLE_RATE,
  samplesPerPeak = MOCK_SAMPLES_PER_PEAK,
): Waveform {
  const peaks: number[] = []
  for (let i = 0; i < samples.length; i += samplesPerPeak) {
    let lo = 0
    let hi = 0
    for (let j = i; j < Math.min(samples.length, i + samplesPerPeak); j++) {
      lo = Math.min(lo, samples[j]!)
      hi = Math.max(hi, samples[j]!)
    }
    peaks.push(Math.max(-128, Math.round(lo * 128)), Math.min(127, Math.round(hi * 127)))
  }
  return { sampleRate, samplesPerPeak, channels: 1, peaks }
}

const audioCache = new Map<string, Float32Array>()

export function mockAudio(assetId: string, duration: number): Float32Array {
  const key = `${assetId}:${duration}`
  let s = audioCache.get(key)
  if (!s) {
    s = synthAudio(assetId, duration)
    audioCache.set(key, s)
  }
  return s
}

// --- видео ---

export const PROXY_W = 320
export const PROXY_H = 180
export const PROXY_FPS = 15

const videoCache = new Map<string, Promise<Blob | null>>()

/** proxy.mp4 ассета: цветной фон, крупный таймкод исходника и номер кадра. null — нет WebCodecs (Node). */
export function mockProxy(assetId: string, name: string, duration: number): Promise<Blob | null> {
  const key = `${assetId}:${duration}`
  let p = videoCache.get(key)
  if (!p) {
    p = renderProxy(assetId, name, duration).catch((e: unknown) => {
      console.warn('[mock] proxy не сгенерирован:', e)
      return null
    })
    videoCache.set(key, p)
  }
  return p
}

async function renderProxy(assetId: string, name: string, duration: number): Promise<Blob | null> {
  if (typeof OffscreenCanvas === 'undefined' || typeof VideoEncoder === 'undefined') return null
  const mb = await import('mediabunny')
  const canvas = new OffscreenCanvas(PROXY_W, PROXY_H)
  const ctx = canvas.getContext('2d')
  if (!ctx) return null

  // MP4 с кодеком, который браузер умеет и закодировать, и проиграть (у Chromium без проприетарных
  // кодеков нет H.264 — тогда VP9/AV1 в MP4), запасной вариант — WebM/VP8
  const probe = document.createElement('video')
  const candidates: { codec: 'avc' | 'vp9' | 'av1' | 'vp8'; webm: boolean }[] = [
    { codec: 'avc', webm: false },
    { codec: 'vp9', webm: false },
    { codec: 'av1', webm: false },
    { codec: 'vp8', webm: true },
  ]
  let chosen: (typeof candidates)[number] | null = null
  for (const c of candidates) {
    const mime = c.webm ? 'video/webm; codecs="vp8"' : mp4Mime(c.codec)
    if (!probe.canPlayType(mime)) continue
    if (await mb.canEncodeVideo(c.codec, { width: PROXY_W, height: PROXY_H })) {
      chosen = c
      break
    }
  }
  if (!chosen) return null

  const target = new mb.BufferTarget()
  const output = new mb.Output({
    format: chosen.webm ? new mb.WebMOutputFormat() : new mb.Mp4OutputFormat({ fastStart: 'in-memory' }),
    target,
  })
  const source = new mb.CanvasSource(canvas, {
    codec: chosen.codec,
    quality: mb.QUALITY_LOW,
    keyFrameInterval: 10 / PROXY_FPS, // GOP 10, как у настоящего прокси
  })
  output.addVideoTrack(source, { frameRate: PROXY_FPS })
  await output.start()

  const hue = hashOf(assetId) % 360
  const frames = Math.max(1, Math.round(duration * PROXY_FPS))
  for (let i = 0; i < frames; i++) {
    const t = i / PROXY_FPS
    drawProxyFrame(ctx, name, t, i, hue)
    await source.add(t, 1 / PROXY_FPS)
  }
  source.close()
  await output.finalize()
  const buffer = target.buffer
  if (!buffer) return null
  return new Blob([buffer], { type: chosen.webm ? 'video/webm' : 'video/mp4' })
}

function mp4Mime(codec: 'avc' | 'vp9' | 'av1' | 'vp8'): string {
  const codecs = { avc: 'avc1.42001f', vp9: 'vp09.00.10.08', av1: 'av01.0.04M.08', vp8: 'vp8' }[codec]
  return `video/mp4; codecs="${codecs}"`
}

function drawProxyFrame(
  ctx: OffscreenCanvasRenderingContext2D,
  name: string,
  t: number,
  i: number,
  hue: number,
): void {
  const g = ctx.createLinearGradient(0, 0, PROXY_W, PROXY_H)
  g.addColorStop(0, `hsl(${(hue + t * 12) % 360} 55% 35%)`)
  g.addColorStop(1, `hsl(${(hue + 60 + t * 12) % 360} 60% 15%)`)
  ctx.fillStyle = g
  ctx.fillRect(0, 0, PROXY_W, PROXY_H)
  // бегущая полоса — движение видно глазом
  const x = ((t * 80) % (PROXY_W + 40)) - 20
  ctx.fillStyle = 'rgba(255,255,255,0.25)'
  ctx.fillRect(x, 0, 20, PROXY_H)
  ctx.fillStyle = '#fff'
  ctx.font = 'bold 44px sans-serif'
  ctx.fillText(`${t.toFixed(2)}s`, 16, 100)
  ctx.font = '14px sans-serif'
  ctx.fillStyle = 'rgba(255,255,255,0.8)'
  ctx.fillText(`${name} · кадр ${i}`, 16, 160)
}

// --- Range ---

/** Ответ на Range-запрос (206 + Content-Range), как у бэка (FileResponse). */
export function rangeResponse(body: Uint8Array<ArrayBuffer>, request: Request, type: string): Response {
  const size = body.byteLength
  const range = request.headers.get('range')
  const m = range ? /bytes=(\d*)-(\d*)/.exec(range) : null
  const headers: Record<string, string> = { 'Content-Type': type, 'Accept-Ranges': 'bytes' }
  if (!m) return new Response(body, { status: 200, headers: { ...headers, 'Content-Length': String(size) } })
  let start = m[1] ? parseInt(m[1], 10) : NaN
  let end = m[2] ? parseInt(m[2], 10) : size - 1
  if (Number.isNaN(start)) {
    // bytes=-N — последние N байт
    start = Math.max(0, size - end)
    end = size - 1
  }
  end = Math.min(end, size - 1)
  if (start >= size || start > end) {
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } })
  }
  return new Response(body.slice(start, end + 1), {
    status: 206,
    headers: {
      ...headers,
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Content-Length': String(end - start + 1),
    },
  })
}
