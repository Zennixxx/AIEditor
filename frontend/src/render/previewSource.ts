// Источник кадров для превью: <video> из пула плеера, при быстром скрабе / неготовом видео — тайл
// атласа thumbs, для картинок — оригинал.
import { assetLookup, player } from '@/playback/player'
import { frameReady, seekFps } from '@/playback/videoPool'
import type { Project } from '@/shared/types.gen'
import { getImage, getThumbs, thumbTile } from '@/store/media'
import { useUi } from '@/store/ui'
import type { LayerStep } from './framePlan'
import type { FrameImage, FrameResolver } from './frameSource'

function imageSize(img: HTMLImageElement): { width: number; height: number } {
  return { width: img.naturalWidth, height: img.naturalHeight }
}

export function previewResolver(project: Project): FrameResolver {
  const lookup = assetLookup(project)
  const { playing } = useUi.getState()
  const fast = player.scrubbingFast()
  return (step: LayerStep, which?: 'next'): FrameImage | null => {
    const asset = lookup(step.clip.assetId)
    if (!asset) return null
    if (which === 'next') {
      const partner = player.video.partner(step.clip.id)
      const blend = step.blend
      if (fast || !blend || !partner || partner.videoWidth === 0) return null
      if (!frameReady(partner, blend.next, blend.fps, false)) return null
      return {
        kind: 'video',
        source: partner,
        width: partner.videoWidth,
        height: partner.videoHeight,
        dynamic: true,
      }
    }
    if (asset.kind === 'image') {
      const img = getImage(`/api/assets/${asset.id}/original`)
      if (!img || img.naturalWidth === 0) return null
      return { kind: 'image', source: img, ...imageSize(img), dynamic: false }
    }
    const el = player.video.element(step.clip.id)
    const fps = seekFps(step.clip, lookup, project.fps)
    if (!fast && el && frameReady(el, step.src, fps, playing) && el.videoWidth > 0) {
      return { kind: 'video', source: el, width: el.videoWidth, height: el.videoHeight, dynamic: true }
    }
    const thumbs = getThumbs(asset.derived.thumbs)
    const tile = thumbs ? thumbTile(thumbs, step.src) : null
    const atlas = tile ? getImage(tile.sprite) : null
    if (!tile || !atlas || atlas.naturalWidth === 0) return null
    return {
      kind: 'thumb',
      source: atlas,
      ...imageSize(atlas),
      crop: { x: tile.sx, y: tile.sy, w: tile.sw, h: tile.sh },
      dynamic: false,
    }
  }
}
