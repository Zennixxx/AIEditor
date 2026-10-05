import { useState, type PointerEvent as ReactPointerEvent } from 'react'
import * as actions from '@/app/actions'
import { laneKeyEase } from '@/model/clipKeys'
import {
  clipAnimatable,
  evaluateAnimatable,
  isAnimated,
  keyAt,
  KEY_EPS,
  type AnimProp,
  type LaneProp,
} from '@/model/keyframes'
import { findClip } from '@/model/lookup'
import { snapToFrame } from '@/shared/time'
import type { Clip, Ease, EaseName, Project } from '@/shared/types.gen'
import { useProject } from '@/store/project'
import { useUi } from '@/store/ui'
import styles from './Inspector.module.css'

interface PropUi {
  prop: AnimProp
  lane: LaneProp
  label: string
  unit: string
  /** Значение проекта → значение в поле ввода. */
  toUi: (v: number, p: Pick<Project, 'width' | 'height'>) => number
  fromUi: (u: number, p: Pick<Project, 'width' | 'height'>) => number
  /** Шаг поля и «горячего текста» (на пиксель движения мыши). */
  step: number
  min?: number
  max?: number
  digits: number
}

// координаты CONTRACT §1 в привычных единицах: позиция — px проекта от центра, масштаб и непрозрачность — %
const PROPS: readonly PropUi[] = [
  {
    prop: 'x',
    lane: 'position',
    label: 'Позиция X',
    unit: 'px',
    toUi: (v, p) => (v * p.width) / 2,
    fromUi: (u, p) => u / (p.width / 2),
    step: 1,
    digits: 1,
  },
  {
    prop: 'y',
    lane: 'position',
    label: 'Позиция Y',
    unit: 'px',
    toUi: (v, p) => (v * p.height) / 2,
    fromUi: (u, p) => u / (p.height / 2),
    step: 1,
    digits: 1,
  },
  {
    prop: 'scale',
    lane: 'scale',
    label: 'Масштаб',
    unit: '%',
    toUi: (v) => v * 100,
    fromUi: (u) => u / 100,
    step: 0.5,
    min: 1,
    digits: 1,
  },
  {
    prop: 'rotation',
    lane: 'rotation',
    label: 'Поворот',
    unit: '°',
    toUi: (v) => v,
    fromUi: (u) => u,
    step: 0.5,
    digits: 1,
  },
  {
    prop: 'opacity',
    lane: 'opacity',
    label: 'Непрозрачность',
    unit: '%',
    toUi: (v) => v * 100,
    fromUi: (u) => u / 100,
    step: 0.5,
    min: 0,
    max: 100,
    digits: 1,
  },
]

const EASES: { ease: EaseName; label: string; title: string }[] = [
  { ease: 'linear', label: 'Лин', title: 'Линейно' },
  { ease: 'easeIn', label: 'In', title: 'Плавный разгон (ease in)' },
  { ease: 'easeOut', label: 'Out', title: 'Плавное торможение (ease out)' },
  { ease: 'easeInOut', label: 'In-Out', title: 'Плавно с обеих сторон (ease in-out)' },
  { ease: 'hold', label: 'Hold', title: 'Удержание: скачок на следующем ключе' },
]

const seal = () => useProject.getState().sealHistory()
let scrubSeq = 0

function clamp(v: number, min = -Infinity, max = Infinity): number {
  return Math.min(Math.max(v, min), max)
}

/** Свойства transform/opacity видеоклипа: значения под плейхедом, секундомер, ключи, интерполяция, график. */
export function ClipTransform({ clipId }: { clipId: string }) {
  const clip = useProject((s) => findClip(s.project, clipId)?.clip)
  const width = useProject((s) => s.project.width)
  const height = useProject((s) => s.project.height)
  const fps = useProject((s) => s.project.fps)
  const playhead = useUi((s) => s.playhead)
  const keySelection = useUi((s) => s.keySelection)
  const [focus, setFocus] = useState<AnimProp>('scale')
  if (!clip) return null
  const dims = { width, height }
  // время от начала клипа под плейхедом: в пределах клипа, по сетке кадров
  const raw = playhead - clip.start
  const inside = raw >= -KEY_EPS && raw <= clip.duration + KEY_EPS
  const local = clamp(snapToFrame(raw, fps), 0, clip.duration)
  const focusUi = PROPS.find((p) => p.prop === focus)!
  const focusKey = keyAt(clipAnimatable(clip, focus), local)
  const ownSelection = keySelection.filter((k) => k.clipId === clip.id)
  const currentEase: Ease | null =
    ownSelection.length > 0
      ? laneKeyEase(clip, ownSelection[0]!.lane, ownSelection[0]!.t)
      : (focusKey?.ease ?? null)

  return (
    <section className={styles.section} data-testid="clip-transform" aria-label="Трансформация">
      <h3 className={styles.heading}>
        Трансформация{' '}
        <span className={styles.dimText}>
          · {inside ? `${local.toFixed(2)} с от начала клипа` : 'плейхед вне клипа'}
        </span>
      </h3>
      {PROPS.map((p) => (
        <PropRow
          key={p.prop}
          ui={p}
          clip={clip}
          local={local}
          dims={dims}
          focused={p.prop === focus}
          onFocus={() => setFocus(p.prop)}
        />
      ))}
      <div className={styles.subheading}>
        {focusUi.label}:{' '}
        {ownSelection.length > 0
          ? `интерполяция выделенных ключей (${ownSelection.length})`
          : 'интерполяция ключа под плейхедом'}
      </div>
      <div className={styles.easeRow} role="group" aria-label="Интерполяция">
        {EASES.map((e) => (
          <button
            key={e.ease}
            type="button"
            className={styles.small}
            title={e.title}
            aria-pressed={currentEase === e.ease}
            disabled={ownSelection.length === 0 && !focusKey}
            onClick={() => actions.setKeysEase(clip.id, focus, local, e.ease)}
            data-testid={`ease-${e.ease}`}
          >
            {e.label}
          </button>
        ))}
      </div>
      <KeyGraph clip={clip} ui={focusUi} local={local} dims={dims} />
    </section>
  )
}

function PropRow({
  ui,
  clip,
  local,
  dims,
  focused,
  onFocus,
}: {
  ui: PropUi
  clip: Clip
  local: number
  dims: Pick<Project, 'width' | 'height'>
  focused: boolean
  onFocus: () => void
}) {
  const value = clipAnimatable(clip, ui.prop)
  const animated = isAnimated(value)
  const shown = ui.toUi(evaluateAnimatable(value, local), dims)
  const hasKey = !!keyAt(value, local)
  const set = (u: number, mergeKey?: string) =>
    actions.setAnimValue(clip.id, ui.prop, local, ui.fromUi(clamp(u, ui.min, ui.max), dims), mergeKey)

  // «горячий текст»: перетаскивание подписи меняет значение (Shift — ×10)
  const scrub = (e: ReactPointerEvent<HTMLSpanElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    onFocus()
    const el = e.currentTarget
    el.setPointerCapture(e.pointerId)
    const x0 = e.clientX
    const start = shown
    const key = `scrub${++scrubSeq}`
    const move = (ev: PointerEvent) => {
      const k = ev.shiftKey ? 10 : 1
      set(start + (ev.clientX - x0) * ui.step * k, key)
    }
    const up = () => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', up)
      seal()
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
  }

  return (
    <div className={styles.animRow} data-focused={focused || undefined} data-testid={`anim-${ui.prop}`}>
      <button
        type="button"
        className={styles.stopwatch}
        aria-pressed={animated}
        title={
          animated
            ? 'Выключить анимацию (останется значение под плейхедом)'
            : 'Анимировать: ключ под плейхедом'
        }
        onClick={() => {
          onFocus()
          actions.toggleAnim(clip.id, ui.prop, local)
        }}
        data-testid={`anim-toggle-${ui.prop}`}
      >
        ⏱
      </button>
      <span
        className={styles.hotText}
        onPointerDown={scrub}
        onClick={onFocus}
        title="Тяните влево-вправо (Shift — быстрее)"
      >
        {ui.label}, {ui.unit}
      </span>
      <input
        type="number"
        step={ui.step}
        min={ui.min}
        max={ui.max}
        value={Number(shown.toFixed(ui.digits))}
        onFocus={onFocus}
        onChange={(e) => {
          const u = Number(e.currentTarget.value)
          if (Number.isFinite(u)) set(u, 'input')
        }}
        onBlur={seal}
        data-testid={`anim-value-${ui.prop}`}
      />
      <span className={styles.keyNav}>
        <button
          type="button"
          className={styles.reset}
          disabled={!animated}
          title="Предыдущий ключ"
          onClick={() => actions.gotoKey(clip.id, -1, ui.prop)}
        >
          ◂
        </button>
        <button
          type="button"
          className={styles.keyButton}
          data-on={hasKey || undefined}
          title={hasKey ? 'Удалить ключ под плейхедом' : 'Ключ под плейхедом'}
          onClick={() => {
            onFocus()
            actions.toggleKey(clip.id, ui.prop, local)
          }}
          data-testid={`anim-key-${ui.prop}`}
        >
          ◆
        </button>
        <button
          type="button"
          className={styles.reset}
          disabled={!animated}
          title="Следующий ключ"
          onClick={() => actions.gotoKey(clip.id, 1, ui.prop)}
        >
          ▸
        </button>
      </span>
    </div>
  )
}

/** Упрощённый граф-редактор: кривая значения свойства по длительности клипа, ключи, плейхед. */
function KeyGraph({
  clip,
  ui,
  local,
  dims,
}: {
  clip: Clip
  ui: PropUi
  local: number
  dims: Pick<Project, 'width' | 'height'>
}) {
  const W = 220
  const H = 64
  const pad = 6
  const value = clipAnimatable(clip, ui.prop)
  const D = Math.max(clip.duration, 1e-6)
  const N = 96
  const samples: number[] = []
  for (let i = 0; i <= N; i++) samples.push(ui.toUi(evaluateAnimatable(value, (i / N) * D), dims))
  let lo = Math.min(...samples)
  let hi = Math.max(...samples)
  if (hi - lo < 1e-6) {
    lo -= 1
    hi += 1
  }
  const x = (t: number) => pad + (t / D) * (W - 2 * pad)
  const y = (u: number) => H - pad - ((u - lo) / (hi - lo)) * (H - 2 * pad)
  const pts = samples.map((u, i) => `${x((i / N) * D).toFixed(1)},${y(u).toFixed(1)}`).join(' ')
  const keys = isAnimated(value) ? value : []
  return (
    <svg
      className={styles.keyGraph}
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      data-testid="key-graph"
      data-keys={keys.length}
      aria-label={`График: ${ui.label}`}
    >
      <line className={styles.keyGraphPlayhead} x1={x(local)} x2={x(local)} y1={0} y2={H} />
      <polyline points={pts} />
      {keys.map((k) => (
        <rect
          key={k.t}
          className={styles.keyGraphKey}
          data-on={Math.abs(k.t - local) <= KEY_EPS || undefined}
          x={x(k.t) - 3.5}
          y={y(ui.toUi(k.v, dims)) - 3.5}
          width={7}
          height={7}
          transform={`rotate(45 ${x(k.t)} ${y(ui.toUi(k.v, dims))})`}
          onClick={() => useUi.getState().setPlayhead(clip.start + k.t)}
        >
          <title>
            {k.t.toFixed(2)} с: {ui.toUi(k.v, dims).toFixed(ui.digits)} {ui.unit} ·{' '}
            {typeof k.ease === 'string' ? k.ease : 'bezier'}
          </title>
        </rect>
      ))}
    </svg>
  )
}
