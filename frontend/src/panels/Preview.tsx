import { useEffect, useRef } from 'react'
import { containRect, coverSource } from '@/playback/frame'
import { assetLookup, player } from '@/playback/player'
import { buildFramePlan, type LayerStep } from '@/render/framePlan'
import type { FrameImage } from '@/render/frameSource'
import { previewResolver } from '@/render/previewSource'
import { Renderer, type RenderStats } from '@/render/renderer'
import { formatTimecode } from '@/shared/time'
import type { Project } from '@/shared/types.gen'
import { onMediaLoaded } from '@/store/media'
import { useProject } from '@/store/project'
import { PREVIEW_QUALITIES, useSettings, type PreviewQuality } from '@/store/settings'
import { useUi } from '@/store/ui'
import { Panel } from './Panel'
import styles from './Preview.module.css'

/** Счётчик fps превью (dev): число отрисовок за последнюю секунду. */
const SHOW_FPS = import.meta.env.DEV

/**
 * Запасной путь без WebGL2: Canvas 2D, только кадр верхнего слоя без transform и эффектов.
 */
function drawFallback(ctx: CanvasRenderingContext2D, w: number, h: number, project: Project): RenderStats {
  ctx.fillStyle = project.background || '#000'
  ctx.fillRect(0, 0, w, h)
  const plan = buildFramePlan(project, useUi.getState().playhead)
  const resolve = previewResolver(project)
  const top = [...plan.steps].reverse().find((s): s is LayerStep => s.kind === 'layer')
  const stats: RenderStats = {
    source: 'none',
    clipId: top?.clip.id ?? null,
    layers: 0,
    effects: 0,
    blended: 0,
  }
  const image: FrameImage | null = top ? resolve(top) : null
  if (!image) return stats
  const crop = image.crop ?? { x: 0, y: 0, w: image.width, h: image.height }
  const r = coverSource(crop.w, crop.h, w, h)
  ctx.drawImage(image.source as CanvasImageSource, crop.x + r.x, crop.y + r.y, r.w, r.h, 0, 0, w, h)
  return { ...stats, source: image.kind, layers: 1 }
}

export function Preview() {
  const playhead = useUi((s) => s.playhead)
  const playing = useUi((s) => s.playing)
  const playRate = useUi((s) => s.playRate)
  const fps = useProject((s) => s.project.fps)
  const quality = useSettings((s) => s.previewQuality)
  const viewportRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  const fpsRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    const viewport = viewportRef.current
    const canvas = canvasRef.current
    if (!viewport || !canvas) return
    let renderer: Renderer | null = null
    let ctx2d: CanvasRenderingContext2D | null = null
    try {
      renderer = new Renderer(canvas)
      renderer.warmUp()
    } catch (e) {
      console.warn('Превью: WebGL2 недоступен, Canvas 2D без эффектов', e)
      ctx2d = canvas.getContext('2d')
    }
    canvas.dataset.renderer = renderer ? 'webgl2' : '2d'
    let raf = 0
    let box = { w: viewport.clientWidth, h: viewport.clientHeight }
    const frameTimes: number[] = []
    let fpsShownAt = 0

    const layout = () => {
      const p = useProject.getState().project
      const r = containRect(p.width, p.height, box.w, box.h)
      canvas.style.left = `${r.x}px`
      canvas.style.top = `${r.y}px`
      canvas.style.width = `${r.w}px`
      canvas.style.height = `${r.h}px`
      // буфер — не больше размера проекта, уменьшенный настройкой качества превью
      const dpr = window.devicePixelRatio || 1
      const q = useSettings.getState().previewQuality
      const bw = Math.max(1, Math.round(Math.min(r.w * dpr, p.width) * q))
      const bh = Math.max(1, Math.round(Math.min(r.h * dpr, p.height) * q))
      if (canvas.width !== bw || canvas.height !== bh) {
        canvas.width = bw
        canvas.height = bh
      }
    }

    const countFps = () => {
      const now = performance.now()
      frameTimes.push(now)
      while (frameTimes.length > 0 && frameTimes[0]! < now - 1000) frameTimes.shift()
      if (fpsRef.current && now - fpsShownAt > 500) {
        fpsShownAt = now
        fpsRef.current.textContent = `${frameTimes.length} fps`
      }
    }

    const draw = () => {
      raf = 0
      layout()
      const project = useProject.getState().project
      let res: RenderStats
      if (renderer) {
        const plan = buildFramePlan(project, useUi.getState().playhead, assetLookup(project))
        res = renderer.render(plan, previewResolver(project))
      } else if (ctx2d) {
        res = drawFallback(ctx2d, canvas.width, canvas.height, project)
      } else return
      if (SHOW_FPS) countFps()
      if (canvas.dataset.source !== res.source) canvas.dataset.source = res.source
      const clip = res.clipId ?? ''
      if (canvas.dataset.clipId !== clip) canvas.dataset.clipId = clip
      const fx = String(res.effects)
      if (canvas.dataset.effects !== fx) canvas.dataset.effects = fx
      const blended = String(res.blended)
      if (canvas.dataset.blended !== blended) canvas.dataset.blended = blended
    }
    const redraw = () => {
      if (!raf) raf = requestAnimationFrame(draw)
    }

    const onLost = (e: Event) => e.preventDefault()
    canvas.addEventListener('webglcontextlost', onLost)
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
      useSettings.subscribe(redraw),
      onMediaLoaded(redraw),
      player.onFrame(redraw),
    ]
    redraw()
    return () => {
      ro.disconnect()
      unsubs.forEach((u) => u())
      if (raf) cancelAnimationFrame(raf)
      canvas.removeEventListener('webglcontextlost', onLost)
      renderer?.dispose()
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
          {SHOW_FPS && <span ref={fpsRef} className={styles.fps} data-testid="preview-fps" />}
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
          <select
            className={styles.quality}
            value={quality}
            onChange={(e) =>
              useSettings.getState().setPreviewQuality(Number(e.currentTarget.value) as PreviewQuality)
            }
            title="Качество превью: разрешение буфера (на экспорт не влияет)"
            aria-label="Качество превью"
            data-testid="preview-quality"
          >
            {PREVIEW_QUALITIES.map((q) => (
              <option key={q.value} value={q.value}>
                {q.label}
              </option>
            ))}
          </select>
        </div>
      </div>
    </Panel>
  )
}
