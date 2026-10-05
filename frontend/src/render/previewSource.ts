// Источник кадров для превью: <video> из пула плеера, при быстром скрабе / неготовом видео — тайл
// атласа thumbs, для картинок — оригинал.
import { assetLookup, player } from '@/playback/player'
import { frameReady } from '@/playback/videoPool'
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
  return (step: LayerStep): FrameImage | null => {
    const asset = lookup(step.clip.assetId)
    if (!asset) return null
    if (asset.kind === 'image') {
      const img = getImage(`/api/assets/${asset.id}/original`)
      if (!img || img.naturalWidth === 0) return null
      return { kind: 'image', source: img, ...imageSize(img), dynamic: false }
    }
    const el = player.video.element(step.clip.id)
    if (!fast && el && frameReady(el, step.src, project.fps, playing) && el.videoWidth > 0) {
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
