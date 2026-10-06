import { useEffect, useMemo, useRef, useState } from 'react'
import { ApiError } from '@/api/client'
import { exportApi } from '@/api/export'
import { probeVideoCodecs, VIDEO_CODECS, type EncoderConfig } from '@/export/codecs'
import type { ExportDestination, ExportProgress, ExportResult } from '@/export/exporter'
import { setLastExport } from '@/export/lastResult'
import { downloadBlob, isAbort, JSX_TYPE, MP4_TYPE, pickFile, saveBlob } from '@/export/save'
import {
  clampBitrate,
  CODEC_LABELS,
  defaultBitrateMbps,
  defaultExportSettings,
  EXPORT_FPS,
  exportRange,
  formatBytes,
  formatDuration,
  frameCount,
  outputSize,
  RESOLUTIONS,
  sanitizeFileName,
  type BitrateMode,
  type ExportSettings,
  type ResolutionPreset,
  type VideoCodecId,
} from '@/export/settings'
import { assetLookup } from '@/playback/player'
import { formatTimecode } from '@/shared/time'
import { useProject } from '@/store/project'
import { useUi } from '@/store/ui'
import styles from '@/timeline/CutDialog.module.css'
import own from './ExportDialog.module.css'

type JobState =
  | { state: 'idle'; note?: string }
  | { state: 'running'; progress: ExportProgress | null }
  | { state: 'done'; result: ExportResult; saved: 'file' | 'download' }
  | { state: 'error'; message: string }

const PHASE_LABEL: Record<ExportProgress['phase'], string> = {
  prepare: 'Подготовка…',
  audio: 'Сведение звука…',
  video: 'Рендер кадров',
  finalize: 'Запись файла…',
}

const PROGRESS_INTERVAL_MS = 100

function errorText(e: unknown): string {
  if (e instanceof ApiError) return e.message
  if (e instanceof Error) return e.message
  return String(e)
}

export function ExportDialog() {
  const open = useUi((s) => s.exportDialogOpen)
  return open ? <ExportDialogBody /> : null
}

function ExportDialogBody() {
  const project = useProject((s) => s.project)
  const inPoint = useUi((s) => s.inPoint)
  const outPoint = useUi((s) => s.outPoint)
  const hasInOut = inPoint !== null || outPoint !== null
  const [s, setS] = useState<ExportSettings>(() => defaultExportSettings(project, hasInOut))
  const [bitrateTouched, setBitrateTouched] = useState(false)
  const [job, setJob] = useState<JobState>({ state: 'idle' })
  const [aeStatus, setAeStatus] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  useEffect(() => dialogRef.current?.focus(), [])
  useEffect(() => () => abortRef.current?.abort(), [])

  const running = job.state === 'running'
  const close = () => {
    if (running) return
    useUi.getState().setExportDialogOpen(false)
  }
  const patch = (p: Partial<ExportSettings>) => setS((cur) => ({ ...cur, ...p }))

  const size = outputSize(project, s.resolution)
  const bitrateMbps = bitrateTouched ? s.bitrateMbps : defaultBitrateMbps(size.width, size.height, s.fps)
  const range = exportRange(project, s.range, inPoint, outPoint)
  const frames = frameCount(range, s.fps)

  const probeKey = `${size.width}x${size.height}@${s.fps}:${bitrateMbps}:${s.bitrateMode}`
  const [support, setSupport] = useState<{
    key: string
    configs: Record<VideoCodecId, EncoderConfig | null>
  } | null>(null)
  useEffect(() => {
    let alive = true
    void probeVideoCodecs({
      width: size.width,
      height: size.height,
      fps: s.fps,
      bitrate: bitrateMbps * 1e6,
      bitrateMode: s.bitrateMode,
    }).then((configs) => {
      if (alive) setSupport({ key: probeKey, configs })
    })
    return () => {
      alive = false
    }
  }, [probeKey, size.width, size.height, s.fps, bitrateMbps, s.bitrateMode])

  const configs = support?.key === probeKey ? support.configs : null
  const codec: VideoCodecId | null = useMemo(() => {
    if (!configs) return null
    if (configs[s.codec]) return s.codec
    return VIDEO_CODECS.find((c) => configs[c]) ?? null
  }, [configs, s.codec])

  const blocker =
    frames === 0
      ? 'Пустой диапазон'
      : !configs
        ? 'Проверка кодеков…'
        : !codec
          ? 'Браузер не умеет кодировать видео с такими параметрами'
          : null

  const start = async () => {
    if (blocker || !codec) return
    const fileName = sanitizeFileName(s.fileName)
    let destination: ExportDestination = { kind: 'buffer' }
    try {
      const handle = await pickFile(fileName, MP4_TYPE)
      if (handle === 'canceled') return
      if (handle) destination = { kind: 'file', handle }
    } catch (e) {
      setJob({ state: 'error', message: errorText(e) })
      return
    }
    const controller = new AbortController()
    abortRef.current = controller
    setJob({ state: 'running', progress: null })
    let lastReport = 0
    try {
      const { exportVideo } = await import('@/export/exporter')
      const snapshot = useProject.getState().project
      const result = await exportVideo({
        project: snapshot,
        settings: { ...s, codec, bitrateMbps, fileName },
        range,
        assets: assetLookup(snapshot),
        destination,
        signal: controller.signal,
        onProgress: (progress) => {
          const now = performance.now()
          if (
            progress.phase === 'video' &&
            progress.frame < progress.frames &&
            now - lastReport < PROGRESS_INTERVAL_MS
          )
            return
          lastReport = now
          setJob({ state: 'running', progress })
        },
      })
      setLastExport({
        blob: result.blob,
        bytes: result.bytes,
        frames: result.frames,
        codec: result.codec,
        audio: result.audio?.label ?? null,
        sources: result.sources,
      })
      if (result.blob) downloadBlob(result.blob, fileName)
      setJob({ state: 'done', result, saved: result.blob ? 'download' : 'file' })
    } catch (e) {
      if (controller.signal.aborted || isAbort(e)) setJob({ state: 'idle', note: 'Экспорт отменён' })
      else setJob({ state: 'error', message: errorText(e) })
    } finally {
      abortRef.current = null
    }
  }

  const exportAe = async () => {
    setAeStatus('Генерация скрипта…')
    try {
      const blob = await exportApi.aeJsx(useProject.getState().project)
      const saved = await saveBlob(blob, sanitizeFileName(project.name, '.jsx'), JSX_TYPE)
      setAeStatus(saved === 'canceled' ? null : 'Скрипт для After Effects сохранён')
    } catch (e) {
      setAeStatus(`Ошибка: ${errorText(e)}`)
    }
  }

  const progress = job.state === 'running' ? job.progress : null
  const pct = progress ? Math.round(progress.fraction * 100) : 0

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
        className={`${styles.dialog} ${own.dialog}`}
        role="dialog"
        aria-modal="true"
        aria-label="Экспорт"
        data-testid="export-dialog"
      >
        <h2 className={styles.title}>Экспорт видео</h2>

        <fieldset className={own.fields} disabled={running}>
          <section className={styles.section}>
            <h3>Видео</h3>
            <div className={own.grid}>
              <label className={styles.row}>
                Разрешение
                <select
                  value={s.resolution}
                  onChange={(e) => patch({ resolution: e.currentTarget.value as ResolutionPreset })}
                  data-testid="export-resolution"
                >
                  {RESOLUTIONS.map((r) => (
                    <option key={r.value} value={r.value}>
                      {r.value === 'project' ? `${r.label} (${project.width}×${project.height})` : r.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className={styles.row}>
                Кадров/с
                <select
                  value={s.fps}
                  onChange={(e) => patch({ fps: Number(e.currentTarget.value) })}
                  data-testid="export-fps"
                >
                  {EXPORT_FPS.map((f) => (
                    <option key={f} value={f}>
                      {f}
                    </option>
                  ))}
                </select>
              </label>
              <label className={styles.row}>
                Кодек
                <select
                  value={codec ?? s.codec}
                  onChange={(e) => patch({ codec: e.currentTarget.value as VideoCodecId })}
                  data-testid="export-codec"
                >
                  {VIDEO_CODECS.map((c) => (
                    <option key={c} value={c} disabled={!!configs && !configs[c]}>
                      {CODEC_LABELS[c]}
                      {configs && !configs[c] ? ' — не поддерживается' : ''}
                    </option>
                  ))}
                </select>
              </label>
              <label className={styles.row}>
                Битрейт, Мбит/с
                <span className={styles.inline}>
                  <input
                    type="number"
                    min={1}
                    max={200}
                    step={1}
                    value={bitrateMbps}
                    onChange={(e) => {
                      setBitrateTouched(true)
                      patch({ bitrateMbps: clampBitrate(Number(e.currentTarget.value)) })
                    }}
                    data-testid="export-bitrate"
                  />
                  <select
                    value={s.bitrateMode}
                    onChange={(e) => patch({ bitrateMode: e.currentTarget.value as BitrateMode })}
                    data-testid="export-bitrate-mode"
                  >
                    <option value="variable">VBR</option>
                    <option value="constant">CBR</option>
                  </select>
                </span>
              </label>
            </div>
            <div className={styles.hint} data-testid="export-size">
              {size.width}×{size.height}, {s.fps} к/с
            </div>
          </section>

          <section className={styles.section}>
            <h3>Диапазон</h3>
            <div className={styles.inline}>
              <label>
                <input
                  type="radio"
                  name="export-range"
                  checked={s.range === 'all'}
                  onChange={() => patch({ range: 'all' })}
                  data-testid="export-range-all"
                />
                Весь проект
              </label>
              <label title={hasInOut ? undefined : 'Поставьте точки I / O на таймлайне'}>
                <input
                  type="radio"
                  name="export-range"
                  checked={s.range === 'inout'}
                  disabled={!hasInOut}
                  onChange={() => patch({ range: 'inout' })}
                  data-testid="export-range-inout"
                />
                In–Out
              </label>
            </div>
            <div className={styles.hint} data-testid="export-range">
              {formatTimecode(range.start, project.fps)} — {formatTimecode(range.end, project.fps)} ·{' '}
              {formatDuration(range.end - range.start)} · {frames} кадров
            </div>
          </section>

          <section className={styles.section}>
            <h3>Файл</h3>
            <input
              className={own.name}
              type="text"
              value={s.fileName}
              onChange={(e) => patch({ fileName: e.currentTarget.value })}
              onBlur={() => patch({ fileName: sanitizeFileName(s.fileName) })}
              data-testid="export-filename"
            />
          </section>
        </fieldset>

        <div className={own.status} data-testid="export-status" data-state={job.state}>
          {job.state === 'running' && (
            <>
              <div className={own.bar}>
                <div className={own.fill} style={{ width: `${pct}%` }} />
              </div>
              <div className={own.meta} data-testid="export-progress" data-fraction={progress?.fraction ?? 0}>
                <span>
                  {progress ? PHASE_LABEL[progress.phase] : PHASE_LABEL.prepare}
                  {progress?.phase === 'video' && ` ${progress.frame}/${progress.frames}`}
                </span>
                <span>
                  {pct}%{progress?.eta != null && ` · осталось ${formatDuration(progress.eta)}`}
                </span>
              </div>
            </>
          )}
          {job.state === 'done' && (
            <span className={own.ok}>
              Готово: {job.result.frames} кадров, {formatBytes(job.result.bytes)}
              {job.saved === 'download' ? ' — скачано' : ' — сохранено'}
              {job.result.audio ? `, звук ${job.result.audio.label}` : ', без звука'}
              {job.result.warnings.map((w) => (
                <span key={w} className={styles.error}>
                  {' '}
                  {w}
                </span>
              ))}
            </span>
          )}
          {job.state === 'error' && <span className={styles.error}>{job.message}</span>}
          {job.state === 'idle' && (job.note || blocker) && (
            <span className={styles.hint}>{job.note ?? blocker}</span>
          )}
        </div>

        <div className={own.footer}>
          <button onClick={() => void exportAe()} disabled={running} data-testid="export-ae">
            After Effects (.jsx)
          </button>
          {aeStatus && (
            <span className={own.aeStatus} data-testid="export-ae-status">
              {aeStatus}
            </span>
          )}
          <span className={own.spacer} />
          {running ? (
            <button onClick={() => abortRef.current?.abort()} data-testid="export-cancel">
              Отменить
            </button>
          ) : (
            <button onClick={close} data-testid="export-close">
              Закрыть
            </button>
          )}
          <button
            className={styles.primary}
            disabled={running || !!blocker}
            onClick={() => void start()}
            data-testid="export-start"
          >
            Экспорт
          </button>
        </div>
      </div>
    </div>
  )
}
