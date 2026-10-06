import {
  ALL_FORMATS,
  Input,
  UrlSource,
  VideoSampleSink,
  type InputVideoTrack,
  type VideoSample,
} from 'mediabunny'
import { assetsApi } from '@/api/assets'
import type { AssetLookup } from '@/playback/timing'
import type { FramePlan, LayerStep } from '@/render/framePlan'
import type { FrameImage } from '@/render/frameSource'
import type { Asset, Clip } from '@/shared/types.gen'
import { FrameCursor } from './frameCursor'
import { originalUrl, videoCandidates } from './sourceUrls'

export class ExportError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ExportError'
  }
}

interface OpenedVideo {
  input: Input
  track: InputVideoTrack
  url: string
}

function retryDelay(previousAttempts: number, error: unknown): number | null {
  if (previousAttempts >= 2) return null
  if (/\b4\d\d\b/.test(String(error))) return null
  return 0.5
}

async function openInput(url: string): Promise<OpenedVideo | null> {
  const input = new Input({
    source: new UrlSource(assetsApi.fileUrl(url), { getRetryDelay: retryDelay }),
    formats: ALL_FORMATS,
  })
  const track = await input.getPrimaryVideoTrack().catch(() => null)
  if (track && (await track.canDecode().catch(() => false))) return { input, track, url }
  input.dispose()
  return null
}

function squarePixels(sample: VideoSample): boolean {
  return sample.pixelAspectRatio.num === sample.pixelAspectRatio.den
}

export class ExportFrames {
  private readonly videos = new Map<string, Promise<OpenedVideo>>()
  private readonly cursors = new Map<string, FrameCursor<VideoSample>>()
  private readonly images = new Map<string, Promise<ImageBitmap>>()
  private readonly canvases = new Map<string, OffscreenCanvas>()
  private frames: VideoFrame[] = []
  readonly used = new Map<string, string>()

  constructor(private readonly lookup: AssetLookup) {}

  async load(plan: FramePlan): Promise<Map<string, FrameImage>> {
    const out = new Map<string, FrameImage>()
    const steps = plan.steps.filter((s): s is LayerStep => s.kind === 'layer')
    await Promise.all(
      steps.map(async (step) => {
        const image = await this.frame(step)
        if (image) out.set(step.clip.id, image)
      }),
    )
    return out
  }

  release(): void {
    for (const f of this.frames) f.close()
    this.frames = []
  }

  async dispose(): Promise<void> {
    this.release()
    await Promise.all([...this.cursors.values()].map((c) => c.dispose()))
    this.cursors.clear()
    await Promise.all([
      ...[...this.videos.values()].map((v) =>
        v.then(
          (o) => o.input.dispose(),
          () => undefined,
        ),
      ),
      ...[...this.images.values()].map((b) =>
        b.then(
          (i) => i.close(),
          () => undefined,
        ),
      ),
    ])
    this.videos.clear()
    this.images.clear()
    this.canvases.clear()
  }

  private asset(id: string): Asset {
    const asset = this.lookup(id)
    if (!asset) throw new ExportError(`Ассет ${id} не найден`)
    return asset
  }

  private async frame(step: LayerStep): Promise<FrameImage | null> {
    const asset = this.asset(step.clip.assetId)
    if (asset.kind === 'image') return this.image(asset)
    const video = await this.video(step.clip, asset)
    let cursor = this.cursors.get(step.clip.id)
    if (!cursor) {
      cursor = new FrameCursor(new VideoSampleSink(video.track))
      this.cursors.set(step.clip.id, cursor)
    }
    const sample = await cursor.at(step.src)
    if (!sample) return null
    if (sample.rotation === 0 && !sample.flip && squarePixels(sample)) {
      const frame = sample.toVideoFrame()
      this.frames.push(frame)
      return {
        kind: 'video',
        source: frame,
        width: frame.displayWidth,
        height: frame.displayHeight,
        dynamic: true,
        key: step.clip.id,
      }
    }
    const w = sample.displayWidth
    const h = sample.displayHeight
    let canvas = this.canvases.get(step.clip.id)
    if (!canvas || canvas.width !== w || canvas.height !== h) {
      canvas = new OffscreenCanvas(w, h)
      this.canvases.set(step.clip.id, canvas)
    }
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new ExportError('Canvas 2D недоступен')
    ctx.clearRect(0, 0, w, h)
    sample.draw(ctx, 0, 0, w, h)
    return { kind: 'video', source: canvas, width: w, height: h, dynamic: true, key: step.clip.id }
  }

  private video(clip: Clip, asset: Asset): Promise<OpenedVideo> {
    const key = `${clip.interpolatedAssetId ?? ''}|${asset.id}`
    let pending = this.videos.get(key)
    if (!pending) {
      pending = (async () => {
        for (const url of videoCandidates(clip, asset, this.lookup)) {
          const opened = await openInput(url)
          if (opened) {
            this.used.set(asset.id, url)
            return opened
          }
        }
        throw new ExportError(`Нет декодируемого источника для «${asset.name}»`)
      })()
      this.videos.set(key, pending)
    }
    return pending
  }

  private async image(asset: Asset): Promise<FrameImage> {
    let pending = this.images.get(asset.id)
    if (!pending) {
      pending = (async () => {
        const res = await fetch(assetsApi.fileUrl(originalUrl(asset)))
        if (!res.ok) throw new ExportError(`Не удалось загрузить «${asset.name}» (HTTP ${res.status})`)
        return createImageBitmap(await res.blob())
      })()
      this.images.set(asset.id, pending)
    }
    const bitmap = await pending
    return {
      kind: 'image',
      source: bitmap,
      width: bitmap.width,
      height: bitmap.height,
      dynamic: false,
      key: `image:${asset.id}`,
    }
  }
}
