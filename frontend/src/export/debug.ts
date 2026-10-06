import { ALL_FORMATS, BlobSource, Input, VideoSampleSink } from 'mediabunny'
import { assetLookup } from '@/playback/player'
import { buildFramePlan } from '@/render/framePlan'
import { previewResolver } from '@/render/previewSource'
import { Renderer } from '@/render/renderer'
import { useProject } from '@/store/project'
import { useUi } from '@/store/ui'
import { psnr } from './compare'
import { lastExport } from './lastResult'
import { ExportFrames } from './sources'

function readCanvas(source: OffscreenCanvas, width: number, height: number): ImageData {
  const canvas = new OffscreenCanvas(width, height)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('Canvas 2D недоступен')
  ctx.drawImage(source, 0, 0, width, height)
  return ctx.getImageData(0, 0, width, height)
}

export function capturePreview(width: number, height: number): { image: ImageData; sources: string[] } {
  const project = useProject.getState().project
  const plan = buildFramePlan(project, useUi.getState().playhead)
  const resolve = previewResolver(project)
  const sources: string[] = []
  const canvas = new OffscreenCanvas(width, height)
  const renderer = new Renderer(canvas, { preserveDrawingBuffer: true })
  try {
    renderer.render(plan, (step) => {
      const image = resolve(step)
      sources.push(image?.kind ?? 'none')
      return image
    })
    return { image: readCanvas(canvas, width, height), sources }
  } finally {
    renderer.dispose()
  }
}

export async function decodeFrame(blob: Blob, t: number): Promise<ImageData | null> {
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS })
  try {
    const track = await input.getPrimaryVideoTrack()
    if (!track) return null
    const sample = await new VideoSampleSink(track).getSample(t)
    if (!sample) return null
    const canvas = new OffscreenCanvas(sample.displayWidth, sample.displayHeight)
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) return null
    sample.draw(ctx, 0, 0)
    sample.close()
    return ctx.getImageData(0, 0, canvas.width, canvas.height)
  } finally {
    input.dispose()
  }
}

export async function exportedTracks(
  blob: Blob,
): Promise<{ video: string | null; audio: string | null; duration: number }> {
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS })
  try {
    const video = await input.getPrimaryVideoTrack()
    const audio = await input.getPrimaryAudioTrack()
    return {
      video: video ? await video.getCodec() : null,
      audio: audio ? await audio.getCodec() : null,
      duration: await input.computeDuration(),
    }
  } finally {
    input.dispose()
  }
}

export async function renderExportFrame(t: number, width: number, height: number): Promise<ImageData> {
  const project = useProject.getState().project
  const plan = buildFramePlan(project, t)
  const frames = new ExportFrames(assetLookup(project))
  const canvas = new OffscreenCanvas(width, height)
  const renderer = new Renderer(canvas, { preserveDrawingBuffer: true })
  try {
    const images = await frames.load(plan)
    renderer.render(plan, (step) => images.get(step.clip.id) ?? null)
    return readCanvas(canvas, width, height)
  } finally {
    frames.release()
    await frames.dispose()
    renderer.dispose()
  }
}

export const exportDebug = {
  capturePreview,
  decodeFrame,
  exportedTracks,
  psnr,
  lastExport,
  renderExportFrame,
}
