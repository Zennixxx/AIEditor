import { useEffect, useMemo, useRef, useState } from 'react'
import { aiApi } from '@/api/ai'
import { jobsApi } from '@/api/analysis'
import type { Asset, Job, StylePreset, StylesFile, TimeRange } from '@/shared/types.gen'
import stylesJson from '@shared/styles.json'
import { errorText, useAi } from '@/store/ai'
import { useAssets } from '@/store/assets'
import { waitForJob } from '@/store/jobWait'
import { useProject } from '@/store/project'
import { useUi } from '@/store/ui'
import dialog from '@/timeline/CutDialog.module.css'
import { isOpsResult, musicChoices } from './autoEdit'
import styles from './AutoEditWizard.module.css'

const SHARED_STYLES = (stylesJson as unknown as StylesFile).styles
const STEPS = ['Трек', 'Клипы', 'Стиль', 'Интенсивность'] as const

type RangeMode = 'clip' | 'inout' | 'custom'

const isStylePreset = (x: unknown): x is StylePreset =>
  typeof x === 'object' && x !== null && 'cutDensity' in x && 'id' in x

const usable = (a: Asset) => (a.kind === 'video' || a.kind === 'image') && !a.parent && a.status === 'ready'

export function AutoEditWizard() {
  const open = useAi((s) => s.wizardOpen)
  return open ? <WizardBody /> : null
}

function WizardBody() {
  const project = useProject((s) => s.project)
  const assets = useAssets((s) => s.assets)
  const order = useAssets((s) => s.order)
  const inPoint = useUi((s) => s.inPoint)
  const outPoint = useUi((s) => s.outPoint)
  const close = () => useAi.getState().setWizardOpen(false)
  const dialogRef = useRef<HTMLDivElement>(null)
  useEffect(() => dialogRef.current?.focus(), [])

  const music = useMemo(
    () =>
      musicChoices(project, (id) => assets[id]?.name ?? project.assets.find((a) => a.id === id)?.name ?? id),
    [project, assets],
  )
  const library = order.map((id) => assets[id]).filter((a): a is Asset => !!a && usable(a))
  const videos = library.filter((a) => a.kind === 'video')

  const [step, setStep] = useState(0)
  const [musicId, setMusicId] = useState(() => music[0]?.clipId ?? '')
  const [rangeMode, setRangeMode] = useState<RangeMode>(
    inPoint !== null && outPoint !== null ? 'inout' : 'clip',
  )
  const chosen = music.find((m) => m.clipId === musicId)
  const [custom, setCustom] = useState<TimeRange>({ start: chosen?.start ?? 0, end: chosen?.end ?? 0 })
  const [assetIds, setAssetIds] = useState<string[]>(() => {
    const used = new Set(
      project.tracks
        .filter((t) => t.kind === 'video')
        .flatMap((t) => t.items.flatMap((i) => (i.type === 'clip' ? [i.assetId] : []))),
    )
    const fromTimeline = library.filter((a) => used.has(a.id)).map((a) => a.id)
    return fromTimeline.length ? fromTimeline : library.map((a) => a.id)
  })
  const [userStyles, setUserStyles] = useState<StylePreset[]>([])
  const [styleId, setStyleId] = useState(SHARED_STYLES[0]?.id ?? '')
  const [refAsset, setRefAsset] = useState(videos[0]?.id ?? '')
  const [refJob, setRefJob] = useState<Job | null>(null)
  const [intensity, setIntensity] = useState(0.7)
  const [job, setJob] = useState<Job | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    aiApi.userStyles().then(setUserStyles, () => undefined)
  }, [])

  const range: TimeRange | undefined =
    rangeMode === 'inout' && inPoint !== null && outPoint !== null
      ? { start: Math.min(inPoint, outPoint), end: Math.max(inPoint, outPoint) }
      : rangeMode === 'custom'
        ? custom
        : undefined
  const allStyles = [...SHARED_STYLES, ...userStyles]
  const style = allStyles.find((s) => s.id === styleId)
  const running = job !== null && (job.status === 'queued' || job.status === 'running')

  const valid = [!!chosen && (!range || range.end > range.start), assetIds.length > 0, !!style, true]

  const detectStyle = async () => {
    if (!refAsset) return
    setError(null)
    try {
      const { jobId } = await aiApi.styleFromReference(refAsset)
      const done = await waitForJob(jobId, setRefJob)
      if (!isStylePreset(done.result)) throw new Error('Бэк не вернул стиль')
      const preset = done.result
      setUserStyles((cur) => [...cur.filter((s) => s.id !== preset.id), preset])
      setStyleId(preset.id)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setRefJob(null)
    }
  }

  const run = async () => {
    if (!chosen || !style) return
    setError(null)
    try {
      const shared = SHARED_STYLES.some((s) => s.id === style.id)
      const { jobId } = await aiApi.autoEdit({
        project: useProject.getState().project,
        musicClipId: chosen.clipId,
        assetIds,
        style: shared ? style.id : 'custom',
        ...(shared ? {} : { customStyle: style }),
        ...(range ? { range } : {}),
        intensity,
      })
      const done = await waitForJob(jobId, setJob)
      if (!isOpsResult(done.result)) throw new Error('Бэк не вернул ops автоэдита')
      useAi.getState().showResult(done.result, `Автоэдит «${style.name}»`)
      close()
    } catch (e) {
      setError(errorText(e))
      setJob(null)
    }
  }

  const cancel = () => {
    if (job && running) void jobsApi.cancel(job.id)
    close()
  }

  return (
    <div
      className={dialog.backdrop}
      onPointerDown={(e) => e.target === e.currentTarget && !running && close()}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Escape' && !running) close()
      }}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        className={`${dialog.dialog} ${styles.wizard}`}
        role="dialog"
        aria-modal="true"
        aria-label="Автоэдит"
        data-testid="auto-edit-wizard"
      >
        <h2 className={dialog.title}>Автоэдит</h2>
        <ol className={styles.steps}>
          {STEPS.map((name, i) => (
            <li key={name} data-active={i === step || undefined} data-done={i < step || undefined}>
              {i + 1}. {name}
            </li>
          ))}
        </ol>

        {step === 0 && (
          <section className={dialog.section}>
            <h3>Музыка</h3>
            {music.length === 0 ? (
              <div className={dialog.error}>
                Нет клипа с маркерами — добавьте трек и запустите анализ музыки.
              </div>
            ) : (
              <select
                value={musicId}
                onChange={(e) => setMusicId(e.currentTarget.value)}
                data-testid="ae-music"
              >
                {music.map((m) => (
                  <option key={m.clipId} value={m.clipId}>
                    {m.name} · {m.start.toFixed(1)}–{m.end.toFixed(1)} с · маркеров {m.markers}
                  </option>
                ))}
              </select>
            )}
            <h3>Участок</h3>
            <label className={dialog.check}>
              <input type="radio" checked={rangeMode === 'clip'} onChange={() => setRangeMode('clip')} />
              Весь трек
            </label>
            <label className={dialog.check}>
              <input
                type="radio"
                checked={rangeMode === 'inout'}
                disabled={inPoint === null || outPoint === null}
                onChange={() => setRangeMode('inout')}
              />
              Между In и Out
              {inPoint !== null && outPoint !== null && (
                <span className={dialog.dim}>
                  {Math.min(inPoint, outPoint).toFixed(2)}–{Math.max(inPoint, outPoint).toFixed(2)} с
                </span>
              )}
            </label>
            <div className={dialog.inline}>
              <label className={dialog.check}>
                <input
                  type="radio"
                  checked={rangeMode === 'custom'}
                  onChange={() => setRangeMode('custom')}
                />
                С
              </label>
              <input
                type="number"
                step={0.1}
                value={custom.start}
                disabled={rangeMode !== 'custom'}
                onChange={(e) => setCustom({ ...custom, start: Number(e.currentTarget.value) })}
              />
              <label>по</label>
              <input
                type="number"
                step={0.1}
                value={custom.end}
                disabled={rangeMode !== 'custom'}
                onChange={(e) => setCustom({ ...custom, end: Number(e.currentTarget.value) })}
              />
              <span>с</span>
            </div>
          </section>
        )}

        {step === 1 && (
          <section className={dialog.section}>
            <h3>Клипы для нарезки</h3>
            {library.length === 0 && (
              <div className={dialog.hint}>В медиатеке нет готовых видео и картинок</div>
            )}
            <div className={`${dialog.list} ${styles.tall}`}>
              {library.map((a) => (
                <label key={a.id} className={dialog.check}>
                  <input
                    type="checkbox"
                    checked={assetIds.includes(a.id)}
                    onChange={() =>
                      setAssetIds((cur) =>
                        cur.includes(a.id) ? cur.filter((x) => x !== a.id) : [...cur, a.id],
                      )
                    }
                    data-testid={`ae-asset-${a.id}`}
                  />
                  {a.name}
                  <span className={dialog.dim}>
                    {a.kind === 'image' ? 'фото' : `${a.duration.toFixed(1)} с`}
                  </span>
                </label>
              ))}
            </div>
          </section>
        )}

        {step === 2 && (
          <section className={dialog.section}>
            <h3>Стиль</h3>
            <div className={styles.cards}>
              {allStyles.map((s) => (
                <button
                  key={s.id}
                  className={styles.card}
                  aria-pressed={s.id === styleId}
                  onClick={() => setStyleId(s.id)}
                  data-testid={`ae-style-${s.id}`}
                >
                  <span className={styles.cardName}>{s.name}</span>
                  {s.description && <span className={styles.cardDesc}>{s.description}</span>}
                </button>
              ))}
            </div>
            <h3>Из референса</h3>
            <div className={dialog.inline}>
              <select
                value={refAsset}
                onChange={(e) => setRefAsset(e.currentTarget.value)}
                disabled={videos.length === 0 || !!refJob}
              >
                {videos.length === 0 && <option value="">Нет видео в медиатеке</option>}
                {videos.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
              <button
                disabled={!refAsset || !!refJob}
                onClick={() => void detectStyle()}
                data-testid="ae-reference"
              >
                {refJob ? `Анализ… ${Math.round(refJob.progress * 100)}%` : 'Определить стиль'}
              </button>
            </div>
          </section>
        )}

        {step === 3 && (
          <section className={dialog.section}>
            <h3>Интенсивность эффектов</h3>
            <label className={dialog.row}>
              {intensity < 0.34 ? 'Мягко' : intensity < 0.67 ? 'Средне' : 'Агрессивно'} ·{' '}
              {Math.round(intensity * 100)}%
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={intensity}
                disabled={running}
                onChange={(e) => setIntensity(Number(e.currentTarget.value))}
                data-testid="ae-intensity"
              />
            </label>
            <div className={dialog.hint}>
              Стиль «{style?.name}», клипов: {assetIds.length}, {chosen?.name}
              {range ? ` (${range.start.toFixed(1)}–${range.end.toFixed(1)} с)` : ''}
            </div>
            {job && (
              <div className={styles.progress} data-testid="ae-progress">
                <div className={styles.bar}>
                  <div className={styles.fill} style={{ width: `${Math.round(job.progress * 100)}%` }} />
                </div>
                <span className={dialog.dim}>{job.message ?? 'В очереди'}</span>
              </div>
            )}
          </section>
        )}

        {error && <div className={dialog.error}>{error}</div>}
        <div className={dialog.actions}>
          <button onClick={cancel} data-testid="ae-cancel">
            Отмена
          </button>
          <button disabled={step === 0 || running} onClick={() => setStep(step - 1)}>
            Назад
          </button>
          {step < STEPS.length - 1 ? (
            <button
              className={dialog.primary}
              disabled={!valid[step]}
              onClick={() => setStep(step + 1)}
              data-testid="ae-next"
            >
              Далее
            </button>
          ) : (
            <button
              className={dialog.primary}
              disabled={running || !valid.every(Boolean)}
              onClick={() => void run()}
              data-testid="ae-run"
            >
              {running ? 'Собираю…' : 'Собрать'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
