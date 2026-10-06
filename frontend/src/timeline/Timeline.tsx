import { useEffect, useMemo, useRef, type DragEvent as ReactDragEvent } from 'react'
import { allClips } from '@/model/lookup'
import { getImage, getThumbs, getWaveform, onMediaLoaded, thumbTile } from '@/store/media'
import { useAi } from '@/store/ai'
import { useAssets } from '@/store/assets'
import { useClipAnalysis } from '@/store/clipAnalysis'
import { useInterpolation } from '@/store/interpolation'
import { usableInterpolation } from '@/model/interpolation'
import { useProject } from '@/store/project'
import { useUi } from '@/store/ui'
import { TimelineController, type PointerInfo } from './controller'
import { ASSET_DND_TYPE, EFFECT_DND_TYPE, PRESET_DND_TYPE } from './dnd'
import { followPlayhead, layoutTracks } from './geometry'
import { hitMoment } from './momentLayout'
import {
  DEFAULT_PALETTE,
  drawTimeline,
  drawTracks,
  movingIds,
  type InterpolationView,
  type MediaSource,
  type Palette,
  type Scene,
} from './render'
import { timelineStats } from './stats'
import styles from './Timeline.module.css'
import { TrackHeaders } from './TrackHeaders'

const media: MediaSource = {
  thumbs: (a) => getThumbs(a.derived.thumbs),
  waveform: (a) => getWaveform(a.derived.waveform),
  image: getImage,
  tile: thumbTile,
}

function readPalette(el: HTMLElement): Palette {
  const css = getComputedStyle(el)
  const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback
  return {
    ...DEFAULT_PALETTE,
    text: v('--text', DEFAULT_PALETTE.text),
    textDim: v('--text-dim', DEFAULT_PALETTE.textDim),
    border: v('--border', DEFAULT_PALETTE.border),
    accent: v('--accent', DEFAULT_PALETTE.accent),
    playhead: v('--playhead', DEFAULT_PALETTE.playhead),
    snap: v('--snap', DEFAULT_PALETTE.snap),
  }
}

/** Поля UI, от которых зависит слой дорожек; остальные (скролл по времени, плейхед…) — только наложение. */
const LAYER_UI_KEYS = [
  'selection',
  'pxPerSec',
  'scrollY',
  'solo',
  'markerSelection',
  'markerVisibility',
  'propLanes',
  'keySelection',
] as const

function sameKey(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i])
}

function pointerInfo(e: PointerEvent | MouseEvent, canvas: HTMLCanvasElement): PointerInfo {
  const r = canvas.getBoundingClientRect()
  return {
    x: e.clientX - r.left,
    y: e.clientY - r.top,
    button: e.button,
    shift: e.shiftKey,
    ctrl: e.ctrlKey || e.metaKey,
    alt: e.altKey,
  }
}

/** Таймлайн: один <canvas> (линейка, дорожки, клипы, плейхед), перерисовка по rAF только при изменениях. */
export function Timeline() {
  const current = useProject((s) => s.project)
  const preview = useAi((s) => s.preview)
  const project = preview?.project ?? current
  const scrollY = useUi((s) => s.scrollY)
  const selectionCount = useUi((s) => s.selection.length)
  const lanes = useUi((s) => s.propLanes)
  const rows = useMemo(() => layoutTracks(project, lanes), [project, lanes])
  const clipCount = useMemo(() => [...allClips(project)].length, [project])
  // эффекты: элементы fx-дорожек + эффекты внутри клипов
  const effectCount = useMemo(
    () =>
      project.tracks.reduce(
        (n, t) => n + t.items.reduce((k, i) => k + (i.type === 'effect' ? 1 : i.effects.length), 0),
        0,
      ),
    [project],
  )

  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const ctrlRef = useRef<TimelineController | null>(null)

  useEffect(() => {
    const wrap = wrapRef.current
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!wrap || !canvas || !ctx) return

    let size = { width: wrap.clientWidth, height: wrap.clientHeight }
    let dirty = true
    let raf = 0
    const palette = readPalette(wrap)
    // Слой дорожек кэшируется на диапазон времени шире экрана: при горизонтальном скролле
    // кадр — один drawImage со сдвигом, перерисовка слоя — только при выходе за диапазон или изменениях.
    const layerCanvas = document.createElement('canvas')
    const layerCtx = layerCanvas.getContext('2d')
    let layer: { t0: number; t1: number; key: unknown[] } | null = null
    let layerStale = true
    let lastScrollX = 0

    const renderLayer = (scene: Scene, key: unknown[], dpr: number, extend: boolean) => {
      const v = scene.view
      const span = v.width / v.pxPerSec
      const ahead = extend ? span : 0
      const forward = v.scrollX >= lastScrollX
      const t0 = Math.max(0, forward ? v.scrollX : v.scrollX - ahead)
      const lw = Math.ceil((v.scrollX + span + (forward ? ahead : 0) - t0) * v.pxPerSec)
      const bw = Math.max(1, Math.round(lw * dpr))
      const bh = Math.max(1, Math.round(v.height * dpr))
      if (layerCanvas.width !== bw || layerCanvas.height !== bh) {
        layerCanvas.width = bw
        layerCanvas.height = bh
      }
      layerCtx!.setTransform(dpr, 0, 0, dpr, 0, 0)
      const lv = { ...v, scrollX: t0, width: lw }
      drawTracks(layerCtx!, {
        ...scene,
        view: lv,
        markers: controller.markersFor(lv),
        keys: controller.keysFor(lv),
        sticky: false,
      })
      layer = { t0, t1: t0 + lw / v.pxPerSec, key }
      layerStale = false
    }

    const draw = () => {
      raf = 0
      if (!dirty) return
      dirty = false
      const startedAt = performance.now()
      const dpr = window.devicePixelRatio || 1
      const w = Math.max(1, Math.round(size.width * dpr))
      const h = Math.max(1, Math.round(size.height * dpr))
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w
        canvas.height = h
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      const ui = useUi.getState()
      const assets = useAssets.getState().assets
      const aiPreview = useAi.getState().preview
      const p = aiPreview?.project ?? useProject.getState().project
      const analyses = useClipAnalysis.getState().byAsset
      const lookup = (id: string) => assets[id] ?? p.assets.find((a) => a.id === id)
      const jobs = useInterpolation.getState().byClip
      const view = controller.view()
      const rows = controller.rows()
      const scene: Scene = {
        project: p,
        rows,
        view,
        assets: (id) => assets[id] ?? p.assets.find((a) => a.id === id),
        selection: new Set(ui.selection),
        playhead: ui.playhead,
        overlay: controller.overlay,
        solo: ui.solo,
        markers: controller.markers(),
        sections: controller.sections(),
        keys: layerCtx ? [] : controller.keys(),
        media,
        palette,
        inPoint: ui.inPoint,
        outPoint: ui.outPoint,
        clipAnalysis: (id) => analyses[id],
        highlight: aiPreview?.project ? aiPreview : null,
        interpolation: (clip): InterpolationView | null => {
          const job = jobs[clip.id]
          if (job) return { state: job.status, progress: job.progress }
          const ready = usableInterpolation(clip, lookup)
          return ready?.parent ? { state: 'ready', quality: ready.parent.quality ?? 'rife' } : null
        },
      }
      if (!layerCtx) {
        drawTimeline(ctx, { ...scene, keys: controller.keys() })
      } else {
        const moving = [...movingIds(controller.overlay)].join(',')
        const key = [p, rows, aiPreview, view.pxPerSec, view.scrollY, view.width, view.height, dpr, moving]
        const span = view.width / view.pxPerSec
        const same = layer !== null && !layerStale && sameKey(layer.key, key)
        const fits = same && layer!.t0 <= view.scrollX + 1e-9 && view.scrollX + span <= layer!.t1 + 1e-9
        if (!fits) renderLayer(scene, key, dpr, same)
        const sx = Math.round((view.scrollX - layer!.t0) * view.pxPerSec * dpr)
        drawTimeline(ctx, scene, { canvas: layerCanvas, sx, dpr })
      }
      lastScrollX = view.scrollX
      timelineStats.record(performance.now() - startedAt)
    }
    const redraw = () => {
      dirty = true
      if (!raf) raf = requestAnimationFrame(draw)
    }
    const invalidate = () => {
      layerStale = true
      redraw()
    }

    const controller = new TimelineController({
      size: () => size,
      redraw,
      setCursor: (c) => {
        if (canvas.style.cursor !== c) canvas.style.cursor = c
      },
    })
    ctrlRef.current = controller

    const ro = new ResizeObserver(() => {
      size = { width: wrap.clientWidth, height: wrap.clientHeight }
      useUi.getState().setViewWidth(size.width)
      invalidate()
    })
    ro.observe(wrap)

    const unsubs = [
      useProject.subscribe(invalidate),
      useAssets.subscribe(invalidate),
      useInterpolation.subscribe(invalidate),
      useAi.subscribe(invalidate),
      useClipAnalysis.subscribe(invalidate),
      useUi.subscribe((s, prev) => {
        // автоскролл за плейхедом при воспроизведении (фаза 1b включает `playing`)
        if (s.playing && s.playhead !== prev.playhead) {
          const x = followPlayhead(
            { pxPerSec: s.pxPerSec, scrollX: s.scrollX, width: size.width },
            s.playhead,
          )
          if (x !== s.scrollX) s.setScroll(x)
        }
        if (LAYER_UI_KEYS.some((k) => s[k] !== prev[k])) invalidate()
        else redraw()
      }),
      onMediaLoaded(invalidate),
    ]

    const onDown = (e: PointerEvent) => {
      if (controller.pointerDown(pointerInfo(e, canvas))) {
        canvas.setPointerCapture(e.pointerId)
        e.preventDefault()
      }
    }
    const onMove = (e: PointerEvent) => {
      const info = pointerInfo(e, canvas)
      controller.pointerMove(info)
      if (e.buttons !== 0) return
      const analyses = useClipAnalysis.getState().byAsset
      const m = hitMoment(controller.rows(), controller.view(), info.x, info.y, (id) => analyses[id])
      const title = m
        ? `${m.description} · ${Math.round(m.score * 100)}%${m.tags.length ? ` · ${m.tags.join(', ')}` : ''}`
        : ''
      if (canvas.title !== title) canvas.title = title
    }
    const onUp = (e: PointerEvent) => controller.pointerUp(pointerInfo(e, canvas))
    const onDouble = (e: MouseEvent) => {
      controller.doubleClick(pointerInfo(e, canvas))
    }
    const onCancel = () => controller.cancel()
    const onLeave = () => controller.leave()
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const r = canvas.getBoundingClientRect()
      controller.wheel({
        x: e.clientX - r.left,
        deltaX: e.deltaX,
        deltaY: e.deltaY,
        ctrl: e.ctrlKey || e.metaKey,
        shift: e.shiftKey,
      })
    }
    canvas.addEventListener('pointerdown', onDown)
    canvas.addEventListener('pointermove', onMove)
    canvas.addEventListener('pointerup', onUp)
    canvas.addEventListener('dblclick', onDouble)
    canvas.addEventListener('pointercancel', onCancel)
    canvas.addEventListener('pointerleave', onLeave)
    canvas.addEventListener('wheel', onWheel, { passive: false })
    redraw()

    return () => {
      ro.disconnect()
      unsubs.forEach((u) => u())
      canvas.removeEventListener('pointerdown', onDown)
      canvas.removeEventListener('pointermove', onMove)
      canvas.removeEventListener('pointerup', onUp)
      canvas.removeEventListener('dblclick', onDouble)
      canvas.removeEventListener('pointercancel', onCancel)
      canvas.removeEventListener('pointerleave', onLeave)
      canvas.removeEventListener('wheel', onWheel)
      if (raf) cancelAnimationFrame(raf)
      ctrlRef.current = null
    }
  }, [])

  const dragAsset = (e: ReactDragEvent) => {
    if (!e.dataTransfer.types.includes(ASSET_DND_TYPE)) return null
    return useUi.getState().draggingAssetId
  }
  const dragEffect = (e: ReactDragEvent) => {
    if (!e.dataTransfer.types.includes(EFFECT_DND_TYPE)) return null
    return useUi.getState().draggingEffect
  }
  const dragPreset = (e: ReactDragEvent) => {
    if (!e.dataTransfer.types.includes(PRESET_DND_TYPE)) return null
    return useUi.getState().draggingPreset
  }
  const local = (e: ReactDragEvent) => {
    const r = canvasRef.current!.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }

  return (
    <div
      className={styles.timeline}
      data-testid="timeline"
      data-clip-count={clipCount}
      data-effect-count={effectCount}
      data-selection-count={selectionCount}
      data-ai-preview={preview ? 'on' : undefined}
    >
      <TrackHeaders rows={rows} scrollY={scrollY} />
      <div
        ref={wrapRef}
        className={styles.canvasWrap}
        onDragOver={(e) => {
          if (!ctrlRef.current) return
          const { x, y } = local(e)
          const preset = dragPreset(e)
          const fx = preset ? null : dragEffect(e)
          const id = preset || fx ? null : dragAsset(e)
          const ok = preset
            ? ctrlRef.current.presetDragOver(x, y, preset, e.shiftKey)
            : fx
              ? ctrlRef.current.effectDragOver(x, y, fx, e.shiftKey)
              : !!id && ctrlRef.current.dragOver(x, y, id, e.shiftKey)
          if (ok) {
            e.preventDefault()
            e.dataTransfer.dropEffect = 'copy'
          }
        }}
        onDragLeave={() => ctrlRef.current?.dragLeave()}
        onDrop={(e) => {
          const preset = e.dataTransfer.getData(PRESET_DND_TYPE) || dragPreset(e)
          if (preset && ctrlRef.current) {
            e.preventDefault()
            const { x, y } = local(e)
            ctrlRef.current.presetDrop(x, y, preset, e.shiftKey)
            useUi.getState().setDraggingPreset(null)
            return
          }
          const fx = e.dataTransfer.getData(EFFECT_DND_TYPE) || dragEffect(e)
          if (fx && ctrlRef.current) {
            e.preventDefault()
            const { x, y } = local(e)
            ctrlRef.current.effectDrop(x, y, fx, e.shiftKey)
            useUi.getState().setDraggingEffect(null)
            return
          }
          const id = e.dataTransfer.getData(ASSET_DND_TYPE) || dragAsset(e)
          if (!id || !ctrlRef.current) return
          e.preventDefault()
          const { x, y } = local(e)
          ctrlRef.current.drop(x, y, id, e.shiftKey)
          useUi.getState().setDraggingAsset(null)
        }}
      >
        <canvas ref={canvasRef} className={styles.canvas} aria-label="Таймлайн: дорожки и клипы" />
      </div>
    </div>
  )
}
