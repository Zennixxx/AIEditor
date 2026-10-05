import { useEffect, useMemo, useRef, useState } from 'react'
import * as actions from '@/app/actions'
import { expandApplyEffectToMarkers, type ApplyFxOp } from '@/model/applyEffectToMarkers'
import { OpsError } from '@/model/ops/errors'
import { CATEGORY_LABELS, effectsByCategory, getEffectDef } from '@/shared/effects-registry'
import { useProject } from '@/store/project'
import { useUi } from '@/store/ui'
import styles from './CutDialog.module.css'
import { filterFromForm, initialFilterForm, type FilterForm } from './filterForm'
import { MarkerFilterFields } from './MarkerFilterFields'

type TargetChoice = 'newFxTrack' | 'clipsUnderMarker' | `track:${string}`

interface FormState extends FilterForm {
  effect: string
  target: TargetChoice
  duration: number
  scaleByStrength: boolean
}

function toOp(f: FormState): ApplyFxOp {
  const target: ApplyFxOp['target'] = f.target.startsWith('track:')
    ? { trackId: f.target.slice('track:'.length) }
    : (f.target as 'newFxTrack' | 'clipsUnderMarker')
  const op: ApplyFxOp = { op: 'applyEffectToMarkers', effect: f.effect, filter: filterFromForm(f), target }
  if (f.duration > 0) op.duration = f.duration
  if (f.scaleByStrength) op.scaleByStrength = true
  return op
}

/** Диалог «Эффект по маркерам» (реализует `applyEffectToMarkers`, CONTRACT §6.2). */
export function FxDialog() {
  const dialog = useUi((s) => s.fxDialog)
  return dialog ? <FxDialogBody key={dialog.effect} effect={dialog.effect} /> : null
}

function FxDialogBody({ effect }: { effect: string }) {
  const project = useProject((s) => s.project)
  const close = () => useUi.getState().openFxDialog(null)
  const [f, setF] = useState<FormState>(() => ({
    ...initialFilterForm(useProject.getState().project, useUi.getState().markerVisibility.minStrength),
    effect,
    target: 'newFxTrack',
    duration: getEffectDef(effect)?.defaultDuration ?? 0.3,
    scaleByStrength: true,
  }))
  const dialogRef = useRef<HTMLDivElement>(null)
  useEffect(() => dialogRef.current?.focus(), [])
  const patch = (p: Partial<FormState>) => setF((cur) => ({ ...cur, ...p }))

  const groups = useMemo(() => [...effectsByCategory()].filter(([category]) => category !== 'transition'), [])
  const fxTracks = project.tracks.filter((t) => t.kind === 'fx')
  const op = useMemo(() => toOp(f), [f])

  // предпросмотр: сколько эффектов будет создано, или причина отказа
  const preview = useMemo(() => {
    try {
      const count = expandApplyEffectToMarkers(project, op).filter((o) => o.op === 'addEffect').length
      return { count, error: null }
    } catch (e) {
      if (e instanceof OpsError) return { count: 0, error: e.message }
      throw e
    }
  }, [project, op])

  const submit = () => {
    if (preview.error) return
    if (actions.applyEffectToMarkers(op)) close()
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
        aria-label="Эффект по маркерам"
        data-testid="fx-dialog"
      >
        <h2 className={styles.title}>Эффект по маркерам</h2>

        <section className={styles.section}>
          <h3>Эффект</h3>
          <label className={styles.row}>
            Эффект
            <select
              value={f.effect}
              onChange={(e) => {
                const id = e.currentTarget.value
                patch({ effect: id, duration: getEffectDef(id)?.defaultDuration ?? f.duration })
              }}
              data-testid="fx-effect"
            >
              {groups.map(([category, defs]) => (
                <optgroup key={category} label={CATEGORY_LABELS[category]}>
                  {defs.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>
          <div className={styles.inline}>
            <label>
              Длительность, с
              <input
                type="number"
                min={0.02}
                step={0.05}
                value={f.duration}
                onChange={(e) => patch({ duration: Math.max(0, Number(e.currentTarget.value) || 0) })}
                data-testid="fx-duration"
              />
            </label>
          </div>
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={f.scaleByStrength}
              onChange={(e) => patch({ scaleByStrength: e.currentTarget.checked })}
              data-testid="fx-scale"
            />
            Сильнее на сильных басах
          </label>
          <label className={styles.row}>
            Куда
            <select
              value={f.target}
              onChange={(e) => patch({ target: e.currentTarget.value as TargetChoice })}
              data-testid="fx-target"
            >
              <option value="newFxTrack">Новая fx-дорожка</option>
              {fxTracks.map((t) => (
                <option key={t.id} value={`track:${t.id}`}>
                  Дорожка {t.name}
                </option>
              ))}
              <option value="clipsUnderMarker">В клипы под маркерами</option>
            </select>
          </label>
        </section>

        <section className={styles.section}>
          <h3>Маркеры</h3>
          <MarkerFilterFields project={project} value={f} onChange={patch} testPrefix="fx" />
        </section>

        <div className={styles.preview} data-testid="fx-preview" data-count={preview.count}>
          {preview.error ? (
            <span className={styles.error}>{preview.error}</span>
          ) : (
            <>Эффектов: {preview.count}</>
          )}
        </div>
        <div className={styles.actions}>
          <button onClick={close} data-testid="fx-cancel">
            Отмена
          </button>
          <button
            className={styles.primary}
            disabled={!!preview.error}
            onClick={submit}
            data-testid="fx-apply"
          >
            Применить
          </button>
        </div>
      </div>
    </div>
  )
}
