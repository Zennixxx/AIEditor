import { useEffect, useRef } from 'react'
import { containRect, coverSource } from '@/playback/frame'
import { assetLookup, player } from '@/playback/player'
import { topVideoLayer } from '@/playback/timing'
import { frameReady } from '@/playback/videoPool'
import { formatTimecode } from '@/shared/time'
import type { Project } from '@/shared/types.gen'
import { getImage, getThumbs, onMediaLoaded, thumbTile } from '@/store/media'
import { useProject } from '@/store/project'
import { useUi } from '@/store/ui'
import { Panel } from './Panel'
import styles from './Preview.module.css'

/** Откуда взят показанный кадр (для отладки и e2e): видео, атлас thumbs, картинка или ничего. */
type FrameSource = 'video' | 'thumb' | 'image' | 'none'

function drawCover(
  ctx: CanvasRenderingContext2D,
  img: CanvasImageSource,
  src: { x: number; y: number; w: number; h: number },
  dw: number,
  dh: number,
): void {
  const r = coverSource(src.w, src.h, dw, dh)
  ctx.drawImage(img, src.x + r.x, src.y + r.y, r.w, r.h, 0, 0, dw, dh)
}

function mediaSize(img: HTMLVideoElement | HTMLImageElement): { w: number; h: number } {
  return img instanceof HTMLVideoElement
    ? { w: img.videoWidth, h: img.videoHeight }
    : { w: img.naturalWidth, h: img.naturalHeight }
}

/** Кадр верхнего видимого клипа под плейхедом (Canvas 2D; композитинг и эффекты — WebGL, фаза 4). */
function drawFrame(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  project: Project,
): {
  source: FrameSource
  clipId: string | null
} {
  const ui = useUi.getState()
  ctx.fillStyle = project.background || '#000'
  ctx.fillRect(0, 0, w, h)
  const layer = topVideoLayer(project, ui.playhead)
  if (!layer) return { source: 'none', clipId: null }
  const clipId = layer.clip.id
  const asset = assetLookup(project)(layer.clip.assetId)
  if (!asset) return { source: 'none', clipId }

  if (asset.kind === 'image') {
    const img = getImage(`/api/assets/${asset.id}/original`)
    if (!img) return { source: 'none', clipId }
    const s = mediaSize(img)
    drawCover(ctx, img, { x: 0, y: 0, ...s }, w, h)
    return { source: 'image', clipId }
  }

  const el = player.video.element(clipId)
  if (!player.scrubbingFast() && el && frameReady(el, layer.src, project.fps, ui.playing)) {
    const s = mediaSize(el)
    if (s.w > 0 && s.h > 0) {
      drawCover(ctx, el, { x: 0, y: 0, ...s }, w, h)
      return { source: 'video', clipId }
    }
  }

  // быстрый скраб / видео ещё не готово — кадр из атласа превью
  const thumbs = getThumbs(asset.derived.thumbs)
  const tile = thumbs ? thumbTile(thumbs, layer.src) : null
  const atlas = tile ? getImage(tile.sprite) : null
  if (tile && atlas) {
    drawCover(ctx, atlas, { x: tile.sx, y: tile.sy, w: tile.sw, h: tile.sh }, w, h)
    return { source: 'thumb', clipId }
  }
  return { source: 'none', clipId }
}

export function Preview() {
  const playhead = useUi((s) => s.playhead)
  const playing = useUi((s) => s.playing)
  const playRate = useUi((s) => s.playRate)
  const fps = useProject((s) => s.project.fps)
  const viewportRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const viewport = viewportRef.current
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!viewport || !canvas || !ctx) return
    let raf = 0
    let box = { w: viewport.clientWidth, h: viewport.clientHeight }

    const layout = () => {
      const p = useProject.getState().project
      const r = containRect(p.width, p.height, box.w, box.h)
      canvas.style.left = `${r.x}px`
      canvas.style.top = `${r.y}px`
      canvas.style.width = `${r.w}px`
      canvas.style.height = `${r.h}px`
      // буфер — не больше размера проекта
      const dpr = window.devicePixelRatio || 1
      const bw = Math.max(1, Math.round(Math.min(r.w * dpr, p.width)))
      const bh = Math.max(1, Math.round(Math.min(r.h * dpr, p.height)))
      if (canvas.width !== bw || canvas.height !== bh) {
        canvas.width = bw
        canvas.height = bh
      }
    }

    const draw = () => {
      raf = 0
      layout()
      const res = drawFrame(ctx, canvas.width, canvas.height, useProject.getState().project)
      if (canvas.dataset.source !== res.source) canvas.dataset.source = res.source
      const clip = res.clipId ?? ''
      if (canvas.dataset.clipId !== clip) canvas.dataset.clipId = clip
    }
    const redraw = () => {
      if (!raf) raf = requestAnimationFrame(draw)
    }

    const ro = new ResizeObserver(() => {
      box = { w: viewport.clientWidth, h: viewport.clientHeight }
      redraw()
    })
    ro.observe(viewport)
    const unsubs = [
      useUi.subscribe((s, prev) => {
        if (s.playhead !== prev.playhead || s.playing !== prev.playing) redraw()
      }),
      useProject.subscribe(redraw),
      onMediaLoaded(redraw),
      player.onFrame(redraw),
    ]
    redraw()
    return () => {
      ro.disconnect()
      unsubs.forEach((u) => u())
      if (raf) cancelAnimationFrame(raf)
    }
  }, [])

  return (
    <Panel title="Превью">
      <div className={styles.wrap}>
        <div className={styles.viewport} ref={viewportRef}>
          <canvas
            ref={canvasRef}
            className={styles.canvas}
            data-testid="preview-canvas"
            aria-label="Кадр под плейхедом"
          />
        </div>
        <div className={styles.transport}>
          <button onClick={() => player.home()} title="В начало (Home)" aria-label="В начало">
            ⏮
          </button>
          <button onClick={() => player.step(-1)} title="Кадр назад (←)" aria-label="Кадр назад">
            ◂
          </button>
          <button
            className={styles.play}
            data-testid="transport-play"
            aria-pressed={playing}
            onClick={() => player.toggle()}
            title="Воспроизведение / пауза (Space), J/K/L — назад/стоп/вперёд"
          >
            {playing ? '❚❚' : '▶'}
          </button>
          <button onClick={() => player.step(1)} title="Кадр вперёд (→)" aria-label="Кадр вперёд">
            ▸
          </button>
          <button onClick={() => player.end()} title="В конец (End)" aria-label="В конец">
            ⏭
          </button>
          <span className={styles.timecode} data-testid="preview-timecode">
            {formatTimecode(playhead, fps)}
          </span>
          {playing && playRate !== 1 && <span className={styles.rate}>{playRate}×</span>}
        </div>
      </div>
    </Panel>
  )
}
