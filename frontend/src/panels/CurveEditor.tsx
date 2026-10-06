import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent,
  type RefObject,
} from 'react'
import * as actions from '@/app/actions'
import { effectiveSpeedFn } from '@/model/clipTime'
import { findClip } from '@/model/lookup'
import { timelineMarkers } from '@/model/markers'
import {
  addRampKey,
  easeBezier,
  moveRampKey,
  removeRampKey,
  setRampKeyEase,
  setSegmentHandle,
  snapToMarker,
} from '@/model/rampKeys'
import { speedAt } from '@/model/timeRemap'
import type { Clip, Ease, TimeRemap, TimeRemapFit } from '@/shared/types.gen'
import { useAssets } from '@/store/assets'
import { useProject } from '@/store/project'
import { useUi } from '@/store/ui'
import styles from './CurveEditor.module.css'

const PAD = { left: 44, right: 14, top: 10, bottom: 18 }
const GRID = [0.1, 0.25, 0.5, 1, 2, 4, 10]
const SAMPLES = 240
const SNAP_PX = 8
const ONE_SNAP_PX = 5
const CUSTOM_BEZIER: Ease = { bezier: [0.3, 0, 0.2, 1] }

const EASES: { ease: Ease; label: string; title: string; id: string }[] = [
  { ease: 'linear', label: 'Лин', title: 'Линейно', id: 'linear' },
  { ease: 'easeIn', label: 'In', title: 'Плавный разгон', id: 'easeIn' },
  { ease: 'easeOut', label: 'Out', title: 'Плавное торможение', id: 'easeOut' },
  { ease: 'easeInOut', label: 'In-Out', title: 'Плавно с обеих сторон', id: 'easeInOut' },
  { ease: 'hold', label: 'Hold', title: 'Скорость держится до следующего ключа', id: 'hold' },
  { ease: CUSTOM_BEZIER, label: 'Безье', title: 'Свои ручки Безье', id: 'bezier' },
]

type Drag = { kind: 'key'; index: number } | { kind: 'handle'; index: number; handle: 1 | 2 }

let dragSeq = 0

function easeId(ease: Ease): string {
  return typeof ease === 'object' ? 'bezier' : ease
}

function useSize(ref: RefObject<HTMLDivElement | null>): { width: number; height: number } {
  const [size, setSize] = useState({ width: 600, height: 160 })
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const update = () =>
      setSize({ width: Math.max(200, el.clientWidth), height: Math.max(80, el.clientHeight) })
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref])
  return size
}

export function CurveEditor() {
  const clipId = useUi((s) => s.curveEditorClipId)
  const clip = useProject((s) => (clipId ? findClip(s.project, clipId)?.clip : undefined))
  useEffect(() => {
    if (clipId && !clip) useUi.getState().openCurveEditor(null)
  }, [clipId, clip])
  if (!clipId || !clip) return null
  return <Editor key={clip.id} clip={clip} />
}

function Editor({ clip }: { clip: Clip }) {
  const asset = useAssets((s) => s.assets[clip.assetId])
  const close = () => useUi.getState().openCurveEditor(null)
  const remap = clip.timeRemap
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target instanceof HTMLSelectElement || e.target instanceof HTMLInputElement) return
    const selected = useUi.getState().curveKey
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault()
      e.stopPropagation()
      const r = findClip(useProject.getState().project, clip.id)?.clip.timeRemap
      if (r && selected !== null && selected > 0 && selected < r.keyframes.length - 1) {
        actions.setTimeRemap(clip.id, removeRampKey(r, selected))
        useUi.getState().selectCurveKey(null)
      }
    } else if (e.key === 'Escape') {
      e.stopPropagation()
      close()
    }
  }
  return (
    <div
      className={styles.editor}
      data-testid="curve-editor"
      aria-label="Граф-редактор скорости"
      onKeyDown={onKey}
    >
      <div className={styles.bar}>
        <span className={styles.title}>Скорость · {clip.label ?? asset?.name ?? clip.assetId}</span>
        {remap ? (
          <RampBar clip={clip} remap={remap} />
        ) : (
          <button
            type="button"
            className={styles.button}
            onClick={() => actions.enableSpeedCurve(clip.id)}
            data-testid="curve-create"
          >
            Создать кривую
          </button>
        )}
        <span className={styles.spacer} />
        <button
          type="button"
          className={styles.button}
          onClick={close}
          title="Закрыть (Shift+F3)"
          data-testid="curve-close"
        >
          ✕
        </button>
      </div>
      {remap ? (
        <Plot clip={clip} remap={remap} />
      ) : (
        <div className={styles.empty}>
          Постоянная скорость ×{clip.speed.toFixed(2)} — создайте кривую, чтобы менять скорость внутри клипа
        </div>
      )}
    </div>
  )
}

function RampBar({ clip, remap }: { clip: Clip; remap: TimeRemap }) {
  const selected = useUi((s) => s.curveKey)
  const key = selected !== null ? remap.keyframes[selected] : undefined
  const canEase = key !== undefined && selected! < remap.keyframes.length - 1
  const inner = selected !== null && selected > 0 && selected < remap.keyframes.length - 1
  return (
    <>
      <span className={styles.group} role="group" aria-label="Интерполяция ключа">
        {EASES.map((e) => (
          <button
            key={e.id}
            type="button"
            className={styles.button}
            title={e.title}
            disabled={!canEase}
            aria-pressed={canEase && easeId(key.ease) === e.id}
            onClick={() => actions.setTimeRemap(clip.id, setRampKeyEase(remap, selected!, e.ease))}
            data-testid={`curve-ease-${e.id}`}
          >
            {e.label}
          </button>
        ))}
      </span>
      <button
        type="button"
        className={styles.button}
        disabled={!inner}
        onClick={() => {
          actions.setTimeRemap(clip.id, removeRampKey(remap, selected!))
          useUi.getState().selectCurveKey(null)
        }}
        title="Удалить ключ (Delete)"
        data-testid="curve-delete-key"
      >
        Удалить ключ
      </button>
      <select
        className={styles.select}
        value={remap.fit}
        onChange={(e) =>
          actions.setTimeRemap(clip.id, { ...remap, fit: e.currentTarget.value as TimeRemapFit })
        }
        aria-label="Длительность"
      >
        <option value="stretch">Растянуть по клипу</option>
        <option value="free">Свободно</option>
      </select>
      <label className={styles.check}>
        <input
          type="checkbox"
          checked={remap.frameBlend}
          onChange={(e) => actions.setTimeRemap(clip.id, { ...remap, frameBlend: e.currentTarget.checked })}
        />
        Смешивание кадров
      </label>
    </>
  )
}

function Plot({ clip, remap }: { clip: Clip; remap: TimeRemap }) {
  const areaRef = useRef<HTMLDivElement>(null)
  const { width, height } = useSize(areaRef)
  const project = useProject((s) => s.project)
  const visibility = useUi((s) => s.markerVisibility)
  const playhead = useUi((s) => s.playhead)
  const selected = useUi((s) => s.curveKey)
  const dragRef = useRef<{ drag: Drag; mergeKey: string } | null>(null)
  const [hover, setHover] = useState<string | null>(null)

  const plotW = width - PAD.left - PAD.right
  const plotH = height - PAD.top - PAD.bottom
  const xOf = (u: number) => PAD.left + u * plotW
  const uOf = (x: number) => Math.min(Math.max((x - PAD.left) / plotW, 0), 1)
  const yOf = (v: number) => PAD.top + (1 - (Math.log10(Math.max(v, 0.1)) + 1) / 2) * plotH
  const speedOf = (y: number) => 10 ** ((1 - (y - PAD.top) / plotH) * 2 - 1)

  const markers = timelineMarkers(project, visibility)
    .filter((m) => m.clipId !== clip.id)
    .map((m) => (m.t - clip.start) / clip.duration)
    .filter((u) => u > 0 && u < 1)

  const keys = remap.keyframes
  const profile: string[] = []
  const effective: string[] = []
  const eff = effectiveSpeedFn(clip)
  const showEffective =
    remap.fit === 'stretch' && Math.abs(eff(0) / Math.max(speedAt(keys, 0), 1e-6) - 1) > 1e-3
  for (let i = 0; i <= SAMPLES; i++) {
    const u = i / SAMPLES
    profile.push(`${xOf(u).toFixed(1)},${yOf(speedAt(keys, u)).toFixed(1)}`)
    if (showEffective) effective.push(`${xOf(u).toFixed(1)},${yOf(eff(u)).toFixed(1)}`)
  }

  const local = (e: PointerEvent | ReactMouseEvent) => {
    const r = (e.currentTarget as Element).closest('svg')!.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }

  const snapU = (u: number, shift: boolean) => {
    if (shift) return u
    const m = snapToMarker(u, markers, SNAP_PX / plotW)
    return m ?? u
  }
  const snapSpeed = (y: number, shift: boolean) => {
    if (!shift && Math.abs(y - yOf(1)) <= ONE_SNAP_PX) return 1
    return speedOf(y)
  }

  const current = () => findClip(useProject.getState().project, clip.id)?.clip.timeRemap ?? null

  const startDrag = (e: PointerEvent, drag: Drag) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    ;(e.currentTarget as Element).closest('svg')!.setPointerCapture(e.pointerId)
    dragRef.current = { drag, mergeKey: `drag${++dragSeq}` }
    useUi.getState().selectCurveKey(drag.index)
  }

  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    const d = dragRef.current
    if (!d) return
    const r = current()
    if (!r) return
    const { x, y } = local(e)
    if (d.drag.kind === 'key') {
      const next = moveRampKey(r, d.drag.index, snapU(uOf(x), e.shiftKey), snapSpeed(y, e.shiftKey))
      actions.setTimeRemap(clip.id, next, d.mergeKey)
      return
    }
    const a = r.keyframes[d.drag.index]
    const b = r.keyframes[d.drag.index + 1]
    if (!a || !b) return
    const span = b.u - a.u
    const hx = span > 0 ? (uOf(x) - a.u) / span : 0
    const bez = easeBezier(a.ease) ?? [0.25, 0.25, 0.75, 0.75]
    const dv = b.speed - a.speed
    const hy = Math.abs(dv) > 1e-6 ? (speedOf(y) - a.speed) / dv : d.drag.handle === 1 ? bez[1] : bez[3]
    actions.setTimeRemap(clip.id, setSegmentHandle(r, d.drag.index, d.drag.handle, hx, hy), d.mergeKey)
  }

  const endDrag = () => {
    if (!dragRef.current) return
    dragRef.current = null
    useProject.getState().sealHistory()
  }

  const onDouble = (e: ReactMouseEvent<SVGSVGElement>) => {
    const r = current()
    if (!r) return
    const { x } = local(e)
    const res = addRampKey(r, snapU(uOf(x), e.shiftKey))
    if (res.index < 0) return
    actions.setTimeRemap(clip.id, res.remap)
    useUi.getState().selectCurveKey(res.index)
  }

  const sel = selected !== null ? keys[selected] : undefined
  const nextKey = selected !== null ? keys[selected + 1] : undefined
  const bez = sel && nextKey ? easeBezier(sel.ease) : null
  const handles =
    sel && nextKey && bez
      ? ([1, 2] as const).map((h) => {
          const hx = h === 1 ? bez[0] : bez[2]
          const hy = h === 1 ? bez[1] : bez[3]
          const u = sel.u + hx * (nextKey.u - sel.u)
          const v = sel.speed + (nextKey.speed - sel.speed) * hy
          const from = h === 1 ? sel : nextKey
          return { h, x: xOf(u), y: yOf(v), fx: xOf(from.u), fy: yOf(from.speed) }
        })
      : []
  const playU = (playhead - clip.start) / clip.duration
  const info = sel
    ? `ключ ${selected! + 1}/${keys.length}: ${(sel.u * clip.duration).toFixed(2)} с · ×${sel.speed.toFixed(2)}`
    : 'Двойной клик — ключ, перетаскивание — время/скорость (Shift — без привязки), Delete — удалить'

  return (
    <div className={styles.area} ref={areaRef} tabIndex={0}>
      <svg
        width={width}
        height={height}
        className={styles.plot}
        onPointerMove={onMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={onDouble}
        onPointerDown={(e) => {
          if (e.target === e.currentTarget) useUi.getState().selectCurveKey(null)
          areaRef.current?.focus()
        }}
        data-testid="curve-plot"
        data-keys={keys.length}
        data-width={plotW}
        data-height={plotH}
      >
        {GRID.map((v) => (
          <g key={v}>
            <line
              className={v === 1 ? styles.gridOne : styles.grid}
              x1={PAD.left}
              x2={width - PAD.right}
              y1={yOf(v)}
              y2={yOf(v)}
            />
            <text className={styles.label} x={PAD.left - 6} y={yOf(v) + 3} textAnchor="end">
              ×{v}
            </text>
          </g>
        ))}
        {markers.map((u, i) => (
          <line
            key={i}
            className={styles.marker}
            x1={xOf(u)}
            x2={xOf(u)}
            y1={PAD.top}
            y2={height - PAD.bottom}
            data-testid="curve-marker"
          />
        ))}
        {playU >= 0 && playU <= 1 && (
          <line className={styles.playhead} x1={xOf(playU)} x2={xOf(playU)} y1={0} y2={height - PAD.bottom} />
        )}
        {showEffective && <polyline className={styles.effective} points={effective.join(' ')} />}
        <polyline className={styles.curve} points={profile.join(' ')} />
        {handles.map((h) => (
          <g key={h.h}>
            <line className={styles.handleLine} x1={h.fx} y1={h.fy} x2={h.x} y2={h.y} />
            <circle
              className={styles.handle}
              cx={h.x}
              cy={h.y}
              r={4}
              onPointerDown={(e) => startDrag(e, { kind: 'handle', index: selected!, handle: h.h })}
              data-testid={`curve-handle-${h.h}`}
            />
          </g>
        ))}
        {keys.map((k, i) => (
          <circle
            key={i}
            className={styles.key}
            data-selected={i === selected || undefined}
            data-hover={hover === `k${i}` || undefined}
            cx={xOf(k.u)}
            cy={yOf(k.speed)}
            r={5}
            onPointerDown={(e) => startDrag(e, { kind: 'key', index: i })}
            onPointerEnter={() => setHover(`k${i}`)}
            onPointerLeave={() => setHover(null)}
            data-testid={`curve-key-${i}`}
          >
            <title>
              {(k.u * clip.duration).toFixed(2)} с · ×{k.speed.toFixed(2)}
            </title>
          </circle>
        ))}
        <text className={styles.info} x={PAD.left} y={height - 4}>
          {info}
        </text>
      </svg>
    </div>
  )
}
