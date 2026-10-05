import { useEffect, useMemo, useRef, useState } from 'react'
import * as actions from '@/app/actions'
import { countSlots, expandCutToMarkers, type CutOp } from '@/model/cutToMarkers'
import { isClip } from '@/model/lookup'
import { MARKER_KINDS } from '@/model/markers'
import { OpsError } from '@/model/ops/errors'
import { SECTION_LABELS } from '@/model/sections'
import type { Clip, CutOrder, MarkerKind, Project, SectionLabel } from '@/shared/types.gen'
import { useAssets } from '@/store/assets'
import { useProject } from '@/store/project'
import { useUi } from '@/store/ui'
import styles from './CutDialog.module.css'

const ORDERS: { value: CutOrder; label: string; disabled?: boolean }[] = [
  { value: 'sequential', label: 'По порядку' },
  { value: 'random', label: 'Случайно' },
  { value: 'bestMoments', label: 'Лучшие моменты (после ИИ-анализа)', disabled: true },
]

interface FormState {
  clipIds: string[]
  trackId: string
  musicClipId: string
  order: CutOrder
  seed: number
  kinds: MarkerKind[]
  minStrength: number
  every: number
  offset: number
  sectionLabels: SectionLabel[]
  useRange: boolean
  rangeStart: number
  rangeEnd: number
}

function videoClips(p: Project): { clip: Clip; trackName: string }[] {
  return p.tracks.flatMap((t) =>
    t.kind === 'video' ? t.items.filter(isClip).map((clip) => ({ clip, trackName: t.name })) : [],
  )
}

function initialState(p: Project, selection: readonly string[], minStrength: number): FormState {
  const all = videoClips(p)
  const picked = all.filter(({ clip }) => selection.includes(clip.id))
  // выделение, а если его нет — все клипы первой видеодорожки, на которой что-то лежит
  const firstTrack = p.tracks.find((t) => t.kind === 'video' && t.items.some(isClip))
  const clipIds = (
    picked.length > 0 ? picked : all.filter(({ clip }) => firstTrack?.items.includes(clip))
  ).map(({ clip }) => clip.id)
  return {
    clipIds,
    trackId: '',
    musicClipId: '',
    order: 'sequential',
    seed: 1,
    kinds: ['bass'],
    minStrength,
    every: 1,
    offset: 0,
    sectionLabels: [],
    useRange: false,
    rangeStart: 0,
    rangeEnd: Math.max(1, Math.round(p.duration)),
  }
}

function toOp(f: FormState): CutOp {
  const filter: CutOp['filter'] = { kinds: f.kinds, every: f.every, offset: f.offset }
  if (f.minStrength > 0) filter.minStrength = f.minStrength
  if (f.musicClipId) filter.musicClipId = f.musicClipId
  if (f.sectionLabels.length > 0) filter.sectionLabels = f.sectionLabels
  if (f.useRange) filter.range = { start: f.rangeStart, end: f.rangeEnd }
  const op: CutOp = { op: 'cutToMarkers', clipIds: f.clipIds, filter, order: f.order }
  if (f.trackId) op.trackId = f.trackId
  if (f.order === 'random') op.seed = f.seed
  return op
}

function toggle<T>(list: readonly T[], item: T): T[] {
  return list.includes(item) ? list.filter((x) => x !== item) : [...list, item]
}

/** Диалог «Нарезать по маркерам»: клипы, фильтр маркеров, порядок и предпросмотр числа слотов. */
export function CutDialog() {
  const open = useUi((s) => s.cutDialogOpen)
  return open ? <CutDialogBody /> : null
}

function CutDialogBody() {
  const project = useProject((s) => s.project)
  const minVisible = useUi((s) => s.markerVisibility.minStrength)
  const close = () => useUi.getState().setCutDialogOpen(false)
  const [f, setF] = useState<FormState>(() =>
    initialState(useProject.getState().project, useUi.getState().selection, minVisible),
  )
  const dialogRef = useRef<HTMLDivElement>(null)
  useEffect(() => dialogRef.current?.focus(), [])
  const patch = (p: Partial<FormState>) => setF((cur) => ({ ...cur, ...p }))
  const assetName = (id: string) => useAssets.getState().assets[id]?.name ?? id

  const clips = useMemo(() => videoClips(project), [project])
  const videoTracks = project.tracks.filter((t) => t.kind === 'video')
  const audioClips = project.tracks.flatMap((t) => (t.kind === 'audio' ? t.items.filter(isClip) : []))
  const op = useMemo(() => toOp(f), [f])

  // предпросмотр: число слотов или причина, по которой нарезка невозможна
  const preview = useMemo(() => {
    if (f.clipIds.length === 0) return { slots: 0, error: 'Выберите хотя бы один клип' }
    try {
      const slots = countSlots(project, op)
      if (slots === 0) return { slots, error: 'Фильтру удовлетворяет меньше двух маркеров' }
      expandCutToMarkers(project, op) // проверка перекрытий и дорожек
      return { slots, error: null }
    } catch (e) {
      if (e instanceof OpsError) return { slots: 0, error: e.message }
      throw e
    }
  }, [project, op, f.clipIds.length])

  const submit = () => {
    if (preview.error) return
    if (actions.cutToMarkers(op)) close()
  }

  return (
    <div
      className={styles.backdrop}
      onPointerDown={(e) => e.target === e.currentTarget && close()}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Escape') close()
      }}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-label="Нарезать по маркерам"
        data-testid="cut-dialog"
      >
        <h2 className={styles.title}>Нарезать по маркерам</h2>

        <section className={styles.section}>
          <h3>Клипы-источники</h3>
          {clips.length === 0 && <div className={styles.hint}>На видеодорожках нет клипов</div>}
          <div className={styles.list}>
            {clips.map(({ clip, trackName }) => (
              <label key={clip.id} className={styles.check}>
                <input
                  type="checkbox"
                  checked={f.clipIds.includes(clip.id)}
                  onChange={() => patch({ clipIds: toggle(f.clipIds, clip.id) })}
                  data-testid={`cut-clip-${clip.id}`}
                />
                {clip.label ?? assetName(clip.assetId)}
                <span className={styles.dim}>
                  {trackName} · {clip.start.toFixed(2)} с · {clip.duration.toFixed(2)} с
                </span>
              </label>
            ))}
          </div>
          <label className={styles.row}>
            Целевая дорожка
            <select
              value={f.trackId}
              onChange={(e) => patch({ trackId: e.currentTarget.value })}
              data-testid="cut-track"
            >
              <option value="">Дорожка первого клипа</option>
              {videoTracks.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
        </section>

        <section className={styles.section}>
          <h3>Маркеры</h3>
          <label className={styles.row}>
            Музыка
            <select
              value={f.musicClipId}
              onChange={(e) => patch({ musicClipId: e.currentTarget.value })}
              data-testid="cut-music"
            >
              <option value="">Первый аудиоклип с маркерами</option>
              {audioClips.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label ?? assetName(c.assetId)}
                </option>
              ))}
            </select>
          </label>
          <div className={styles.chips}>
            {MARKER_KINDS.map((k) => (
              <button
                key={k}
                aria-pressed={f.kinds.includes(k)}
                onClick={() => patch({ kinds: toggle(f.kinds, k) })}
                data-testid={`cut-kind-${k}`}
              >
                {k}
              </button>
            ))}
          </div>
          <label className={styles.row}>
            Порог силы {Math.round(f.minStrength * 100)}%
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={f.minStrength}
              onChange={(e) => patch({ minStrength: Number(e.currentTarget.value) })}
              data-testid="cut-strength"
            />
          </label>
          <div className={styles.inline}>
            <label>
              Каждый
              <input
                type="number"
                min={1}
                step={1}
                value={f.every}
                onChange={(e) =>
                  patch({ every: Math.max(1, Math.round(Number(e.currentTarget.value) || 1)) })
                }
                data-testid="cut-every"
              />
              -й
            </label>
            <label>
              Смещение
              <input
                type="number"
                min={0}
                step={1}
                value={f.offset}
                onChange={(e) =>
                  patch({ offset: Math.max(0, Math.round(Number(e.currentTarget.value) || 0)) })
                }
                data-testid="cut-offset"
              />
            </label>
          </div>
          <div className={styles.chips} title="Секции музыки; ничего не выбрано — любые">
            {SECTION_LABELS.map((l) => (
              <button
                key={l}
                aria-pressed={f.sectionLabels.includes(l)}
                onClick={() => patch({ sectionLabels: toggle(f.sectionLabels, l) })}
                data-testid={`cut-section-${l}`}
              >
                {l}
              </button>
            ))}
          </div>
          <div className={styles.inline}>
            <label className={styles.check}>
              <input
                type="checkbox"
                checked={f.useRange}
                onChange={(e) => patch({ useRange: e.currentTarget.checked })}
                data-testid="cut-range-on"
              />
              Диапазон, с
            </label>
            <input
              type="number"
              min={0}
              step={0.5}
              disabled={!f.useRange}
              value={f.rangeStart}
              onChange={(e) => patch({ rangeStart: Number(e.currentTarget.value) || 0 })}
              data-testid="cut-range-start"
            />
            <span>—</span>
            <input
              type="number"
              min={0}
              step={0.5}
              disabled={!f.useRange}
              value={f.rangeEnd}
              onChange={(e) => patch({ rangeEnd: Number(e.currentTarget.value) || 0 })}
              data-testid="cut-range-end"
            />
          </div>
        </section>

        <section className={styles.section}>
          <h3>Порядок</h3>
          <div className={styles.inline}>
            <select
              value={f.order}
              onChange={(e) => patch({ order: e.currentTarget.value as CutOrder })}
              data-testid="cut-order"
            >
              {ORDERS.map((o) => (
                <option key={o.value} value={o.value} disabled={o.disabled}>
                  {o.label}
                </option>
              ))}
            </select>
            {f.order === 'random' && (
              <label>
                seed
                <input
                  type="number"
                  step={1}
                  value={f.seed}
                  onChange={(e) => patch({ seed: Math.round(Number(e.currentTarget.value) || 0) })}
                  data-testid="cut-seed"
                />
              </label>
            )}
          </div>
        </section>

        <div className={styles.preview} data-testid="cut-preview" data-slots={preview.slots}>
          {preview.error ? (
            <span className={styles.error}>{preview.error}</span>
          ) : (
            <>Слотов: {preview.slots}</>
          )}
        </div>
        <div className={styles.actions}>
          <button onClick={close} data-testid="cut-cancel">
            Отмена
          </button>
          <button
            className={styles.primary}
            disabled={!!preview.error}
            onClick={submit}
            data-testid="cut-apply"
          >
            Нарезать
          </button>
        </div>
      </div>
    </div>
  )
}
