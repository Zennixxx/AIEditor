import { useEffect, useMemo, useRef, useState } from 'react'
import * as actions from '@/app/actions'
import { countSlots, expandCutToMarkers, type CutOp } from '@/model/cutToMarkers'
import { isClip } from '@/model/lookup'
import { OpsError } from '@/model/ops/errors'
import type { Clip, CutOrder, Project } from '@/shared/types.gen'
import { useAssets } from '@/store/assets'
import { useClipAnalysis } from '@/store/clipAnalysis'
import { useProject } from '@/store/project'
import { useUi } from '@/store/ui'
import styles from './CutDialog.module.css'
import { filterFromForm, initialFilterForm, toggle, type FilterForm } from './filterForm'
import { MarkerFilterFields } from './MarkerFilterFields'

const ORDERS: { value: CutOrder; label: string; disabled?: boolean }[] = [
  { value: 'sequential', label: 'По порядку' },
  { value: 'random', label: 'Случайно' },
  { value: 'bestMoments', label: 'Лучшие моменты (ИИ-анализ)' },
]

interface FormState extends FilterForm {
  clipIds: string[]
  trackId: string
  order: CutOrder
  seed: number
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
  return { ...initialFilterForm(p, minStrength), clipIds, trackId: '', order: 'sequential', seed: 1 }
}

function toOp(f: FormState): CutOp {
  const op: CutOp = { op: 'cutToMarkers', clipIds: f.clipIds, filter: filterFromForm(f), order: f.order }
  if (f.trackId) op.trackId = f.trackId
  if (f.order === 'random') op.seed = f.seed
  return op
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
  const op = useMemo(() => toOp(f), [f])
  const analyses = useClipAnalysis((s) => s.byAsset)
  const noMoments =
    f.order === 'bestMoments' &&
    !clips.some(
      ({ clip }) => f.clipIds.includes(clip.id) && (analyses[clip.assetId]?.moments.length ?? 0) > 0,
    )

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
          <MarkerFilterFields project={project} value={f} onChange={patch} testPrefix="cut" />
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
            {noMoments && (
              <span className={styles.hint} data-testid="cut-no-moments">
                Нет ИИ-анализа выбранных клипов — нарезка пойдёт по порядку
              </span>
            )}
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
