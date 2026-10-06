import { useEffect, useMemo, useRef, type DragEvent as ReactDragEvent } from 'react'
import { allClips } from '@/model/lookup'
import { getImage, getThumbs, getWaveform, onMediaLoaded, thumbTile } from '@/store/media'
import { useAssets } from '@/store/assets'
import { useProject } from '@/store/project'
import { useUi } from '@/store/ui'
import { TimelineController, type PointerInfo } from './controller'
import { ASSET_DND_TYPE, EFFECT_DND_TYPE, PRESET_DND_TYPE } from './dnd'
import { followPlayhead, layoutTracks } from './geometry'
import { DEFAULT_PALETTE, drawTimeline, type MediaSource, type Palette } from './render'
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
  const project = useProject((s) => s.project)
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

    const draw = () => {
      raf = 0
      if (!dirty) return
      dirty = false
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
      const p = useProject.getState().project
      drawTimeline(ctx, {
        project: p,
        rows: controller.rows(),
        view: controller.view(),
        assets: (id) => assets[id] ?? p.assets.find((a) => a.id === id),
        selection: new Set(ui.selection),
        playhead: ui.playhead,
        overlay: controller.overlay,
        solo: ui.solo,
        markers: controller.markers(),
        sections: controller.sections(),
        keys: controller.keys(),
        media,
        palette,
        inPoint: ui.inPoint,
        outPoint: ui.outPoint,
      })
    }
    const redraw = () => {
      dirty = true
      if (!raf) raf = requestAnimationFrame(draw)
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
      redraw()
    })
    ro.observe(wrap)

    const unsubs = [
      useProject.subscribe(redraw),
      useAssets.subscribe(redraw),
      useUi.subscribe((s, prev) => {
        // автоскролл за плейхедом при воспроизведении (фаза 1b включает `playing`)
        if (s.playing && s.playhead !== prev.playhead) {
          const x = followPlayhead(
            { pxPerSec: s.pxPerSec, scrollX: s.scrollX, width: size.width },
            s.playhead,
          )
          if (x !== s.scrollX) s.setScroll(x)
        }
        redraw()
      }),
      onMediaLoaded(redraw),
    ]

    const onDown = (e: PointerEvent) => {
      if (controller.pointerDown(pointerInfo(e, canvas))) {
        canvas.setPointerCapture(e.pointerId)
        e.preventDefault()
      }
    }
    const onMove = (e: PointerEvent) => controller.pointerMove(pointerInfo(e, canvas))
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
