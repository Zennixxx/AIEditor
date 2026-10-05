import { describe, expect, it } from 'vitest'
import { API_BASE } from '@/api/config'
import type { Asset, ImportResponse, Job, WsEvent } from '@/shared/types.gen'
import { encodeWav, MOCK_SAMPLE_RATE, rangeResponse, synthAudio, waveformOf } from './media'

describe('mock media', () => {
  it('synthetic audio is deterministic and within [-1, 1]', () => {
    const a = synthAudio('ast_1', 1)
    expect(a).toHaveLength(MOCK_SAMPLE_RATE)
    expect(synthAudio('ast_1', 1)).toEqual(a)
    expect(Math.max(...a.map(Math.abs))).toBeLessThanOrEqual(1)
  })

  it('WAV header + PCM16 body', () => {
    const wav = new DataView(encodeWav(new Float32Array([0, 1, -1]), 8000))
    const tag = (o: number) => String.fromCharCode(...[0, 1, 2, 3].map((i) => wav.getUint8(o + i)))
    expect(tag(0)).toBe('RIFF')
    expect(tag(8)).toBe('WAVE')
    expect(wav.getUint32(24, true)).toBe(8000)
    expect(wav.getUint32(40, true)).toBe(6)
    expect(wav.getInt16(46, true)).toBe(32767)
    expect(wav.getInt16(48, true)).toBe(-32767)
  })

  it('waveform: 256 samples per peak, int8 min/max pairs', () => {
    const samples = synthAudio('ast_2', 2)
    const w = waveformOf(samples)
    expect(w).toMatchObject({ sampleRate: MOCK_SAMPLE_RATE, samplesPerPeak: 256, channels: 1 })
    expect(w.peaks).toHaveLength(Math.ceil(samples.length / 256) * 2)
    expect(w.peaks.every((v) => Number.isInteger(v) && v >= -128 && v <= 127)).toBe(true)
    // бочка в начале каждой доли — громкий пик в первом окне
    expect(w.peaks[1]!).toBeGreaterThan(20)
  })

  it('Range: 206 with Content-Range, open-ended and suffix ranges, 416 out of bounds', async () => {
    const body = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
    const req = (range?: string) => new Request('http://x/f', range ? { headers: { range } } : {})
    const full = rangeResponse(body, req(), 'video/mp4')
    expect(full.status).toBe(200)
    const part = rangeResponse(body, req('bytes=2-4'), 'video/mp4')
    expect(part.status).toBe(206)
    expect(part.headers.get('content-range')).toBe('bytes 2-4/10')
    expect([...new Uint8Array(await part.arrayBuffer())]).toEqual([2, 3, 4])
    const open = rangeResponse(body, req('bytes=7-'), 'video/mp4')
    expect([...new Uint8Array(await open.arrayBuffer())]).toEqual([7, 8, 9])
    const suffix = rangeResponse(body, req('bytes=-2'), 'video/mp4')
    expect(suffix.headers.get('content-range')).toBe('bytes 8-9/10')
    expect(rangeResponse(body, req('bytes=20-'), 'video/mp4').status).toBe(416)
  })
})

describe('mock import (CONTRACT §8.1)', () => {
  it('no `import` job: proxy → thumbs → audio → waveform, ready via WS asset event', async () => {
    const { events } = await import('@/api/events')
    const seen: WsEvent[] = []
    const offJob = events.on('job', (e) => seen.push(e))
    const offAsset = events.on('asset', (e) => seen.push(e))
    events.start()
    try {
      const res = await fetch(`${API_BASE}/assets/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paths: ['D:\\clips\\run.mp4'] }),
      })
      const body = (await res.json()) as ImportResponse
      expect(body.assets[0]!.status).toBe('importing')
      expect(body.jobs).toHaveLength(4)
      const assetId = body.assets[0]!.id
      await waitFor(() => lastAsset(seen, assetId)?.status === 'ready', 8000)
      const kinds = new Set(seen.flatMap((e) => (e.type === 'job' ? [(e.job as Job).kind] : [])))
      expect([...kinds].sort()).toEqual(['audio', 'proxy', 'thumbs', 'waveform'])
      const ready = lastAsset(seen, assetId)!
      expect(ready.derived).toMatchObject({
        proxy: `/api/assets/${assetId}/proxy.mp4`,
        audio: `/api/assets/${assetId}/audio.m4a`,
        thumbs: `/api/assets/${assetId}/thumbs.json`,
        waveform: `/api/assets/${assetId}/waveform.json`,
      })
      // audio.m4a отдаётся с поддержкой Range
      const audio = await fetch(`${API_BASE}/assets/${assetId}/audio.m4a`, {
        headers: { range: 'bytes=0-11' },
      })
      expect(audio.status).toBe(206)
      const thumbs = (await (await fetch(`${API_BASE}/assets/${assetId}/thumbs.json`)).json()) as {
        rows: number
      }
      expect(thumbs.rows).toBe(10)
    } finally {
      offJob()
      offAsset()
      events.stop()
    }
  }, 15000)
})

function lastAsset(events: WsEvent[], id: string): Asset | undefined {
  let res: Asset | undefined
  for (const e of events) if (e.type === 'asset' && e.asset.id === id) res = e.asset
  return res
}

async function waitFor(cond: () => boolean, timeoutMs: number): Promise<void> {
  const until = Date.now() + timeoutMs
  while (!cond()) {
    if (Date.now() > until) throw new Error('timeout')
    await new Promise((r) => setTimeout(r, 50))
  }
}
