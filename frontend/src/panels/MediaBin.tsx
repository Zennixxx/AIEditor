import { useRef, useState, type DragEvent as ReactDragEvent } from 'react'
import { assetsApi } from '@/api/assets'
import type { Asset, Job, JobKind } from '@/shared/types.gen'
import { activeJobs, failedJobs, useAssets } from '@/store/assets'
import { useBackend } from '@/store/backend'
import { useClipAnalysis } from '@/store/clipAnalysis'
import { getThumbs, tilesPerSprite, useMediaVersion } from '@/store/media'
import { useUi } from '@/store/ui'
import { ASSET_DND_TYPE } from '@/timeline/dnd'
import styles from './MediaBin.module.css'
import { EmptyState, Panel } from './Panel'

const JOB_LABELS: Partial<Record<JobKind, string>> = {
  proxy: 'Прокси',
  audio: 'Аудио',
  thumbs: 'Превью-кадры',
  waveform: 'Waveform',
  mezzanine: 'Mezzanine',
  clipAnalysis: 'Анализ',
}

const ACCEPT = 'video/*,audio/*,image/*,.mov,.mkv,.mp3,.wav,.flac,.m4a'

function formatDuration(sec: number): string {
  const s = Math.round(sec)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export function MediaBin() {
  const allOrder = useAssets((s) => s.order)
  const assets = useAssets((s) => s.assets)
  const order = allOrder.filter((id) => !assets[id]?.parent)
  const uploading = useAssets((s) => s.uploading)
  const error = useAssets((s) => s.error)
  const inputRef = useRef<HTMLInputElement>(null)
  const [dropActive, setDropActive] = useState(false)

  const upload = (files: FileList | null) => {
    if (files && files.length > 0) void useAssets.getState().upload([...files])
  }

  const isFileDrag = (e: ReactDragEvent) => e.dataTransfer.types.includes('Files')

  return (
    <Panel
      title="Медиа"
      actions={
        <button
          className={styles.importButton}
          onClick={() => inputRef.current?.click()}
          disabled={uploading > 0}
        >
          {uploading > 0 ? 'Загрузка…' : 'Импорт'}
        </button>
      }
    >
      <input
        ref={inputRef}
        type="file"
        multiple
        accept={ACCEPT}
        hidden
        data-testid="media-import-input"
        onChange={(e) => {
          upload(e.currentTarget.files)
          e.currentTarget.value = ''
        }}
      />
      <div
        className={styles.bin}
        data-drop-active={dropActive || undefined}
        onDragOver={(e) => {
          if (!isFileDrag(e)) return
          e.preventDefault()
          setDropActive(true)
        }}
        onDragLeave={() => setDropActive(false)}
        onDrop={(e) => {
          if (!isFileDrag(e)) return
          e.preventDefault()
          setDropActive(false)
          upload(e.dataTransfer.files)
        }}
      >
        {error && <div className={styles.error}>{error}</div>}
        {order.length === 0 ? (
          <EmptyState title="Нет файлов" hint="Нажмите «Импорт» или перетащите видео и музыку сюда" />
        ) : (
          <ul className={styles.grid} aria-label="Ассеты">
            {order.map((id) => {
              const a = assets[id]
              return a ? <AssetCard key={id} asset={a} /> : null
            })}
          </ul>
        )}
      </div>
    </Panel>
  )
}

function AssetCard({ asset }: { asset: Asset }) {
  const jobs = useAssets((s) => s.jobs)
  const running = activeJobs(jobs, asset.id)
  const failed = failedJobs(jobs, asset.id)
  const ready = asset.status === 'ready'

  return (
    <li
      className={styles.card}
      data-testid="asset-card"
      data-asset-id={asset.id}
      data-status={asset.status}
      draggable={ready}
      title={ready ? `${asset.name} — перетащите на таймлайн` : asset.name}
      onDragStart={(e) => {
        e.dataTransfer.setData(ASSET_DND_TYPE, asset.id)
        e.dataTransfer.setData('text/plain', asset.name)
        e.dataTransfer.effectAllowed = 'copy'
        useUi.getState().setDraggingAsset(asset.id)
      }}
      onDragEnd={() => useUi.getState().setDraggingAsset(null)}
    >
      <Thumb asset={asset} />
      <div className={styles.meta}>
        <span className={styles.name}>{asset.name}</span>
        <span className={styles.info}>
          <span className={styles.kind} data-kind={asset.kind}>
            {asset.kind === 'video' ? 'Видео' : asset.kind === 'audio' ? 'Аудио' : 'Фото'}
          </span>
          {asset.kind !== 'image' && <span>{formatDuration(asset.duration)}</span>}
          <span className={styles.status} data-status={asset.status}>
            {asset.status === 'importing' ? 'импорт…' : asset.status === 'failed' ? 'ошибка' : ''}
          </span>
        </span>
        {running.map((j) => (
          <JobProgress key={j.id} job={j} />
        ))}
        {asset.kind === 'video' && ready && !asset.parent && <AiAnalysis asset={asset} />}
        {failed.map((j) => (
          <span key={j.id} className={styles.jobError} title={j.error?.message}>
            {JOB_LABELS[j.kind] ?? j.kind}: {j.error?.message ?? 'ошибка'}
          </span>
        ))}
      </div>
    </li>
  )
}

function JobProgress({ job }: { job: Job }) {
  return (
    <div className={styles.job} data-testid="asset-job" title={job.message}>
      <span>{JOB_LABELS[job.kind] ?? job.kind}</span>
      <div className={styles.bar}>
        <div className={styles.fill} style={{ width: `${Math.round(job.progress * 100)}%` }} />
      </div>
    </div>
  )
}

function Thumb({ asset }: { asset: Asset }) {
  useMediaVersion()
  const thumbs = asset.kind === 'video' ? getThumbs(asset.derived.thumbs) : null
  const sprite = thumbs?.sprites[0]
  if (!thumbs || !sprite) {
    return (
      <div className={styles.thumb} data-kind={asset.kind}>
        {asset.kind === 'audio' ? '♪' : asset.kind === 'image' ? '▣' : '▶'}
      </div>
    )
  }
  // кадр из середины ролика (если он на первом атласе) — показательнее первого
  const index = Math.min(Math.floor(thumbs.count / 2), tilesPerSprite(thumbs) - 1)
  const scale = 96 / thumbs.tileWidth
  const col = index % thumbs.columns
  const row = Math.floor(index / thumbs.columns)
  return (
    <div
      className={styles.thumb}
      style={{
        backgroundImage: `url(${assetsApi.fileUrl(sprite)})`,
        backgroundSize: `${thumbs.columns * thumbs.tileWidth * scale}px auto`,
        backgroundPosition: `${-col * thumbs.tileWidth * scale}px ${-row * thumbs.tileHeight * scale}px`,
      }}
    />
  )
}

function AiAnalysis({ asset }: { asset: Asset }) {
  const analysis = useClipAnalysis((s) => s.byAsset[asset.id])
  const running = useClipAnalysis((s) => s.running[asset.id])
  const error = useClipAnalysis((s) => s.errors[asset.id])
  const gemini = useBackend((s) => s.health?.gemini)
  const done = !!analysis?.model
  const title = done
    ? `${analysis.summary}
Моментов: ${analysis.moments.length}. Нажмите, чтобы проанализировать заново.`
    : gemini === false
      ? 'Ключ Gemini не задан на бэке'
      : 'Найти моменты для эдита (Gemini)'
  return (
    <span className={styles.ai}>
      <button
        className={styles.aiButton}
        disabled={!!running || gemini === false}
        title={title}
        onClick={(e) => {
          e.stopPropagation()
          void useClipAnalysis.getState().analyze(asset.id, done)
        }}
        data-testid="asset-ai-analyze"
      >
        {running ? 'ИИ…' : done ? `ИИ ✓ ${analysis.moments.length}` : 'Проанализировать ИИ'}
      </button>
      {error && (
        <span className={styles.jobError} title={error}>
          {error}
        </span>
      )}
    </span>
  )
}
