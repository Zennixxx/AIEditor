import { useState } from 'react'
import { AUTO_KINDS, DEFAULT_ANALYSIS_PARAMS } from '@/model/markers'
import { findClip } from '@/model/lookup'
import type { MusicAnalysisParams } from '@/shared/types.gen'
import { useAnalysis } from '@/store/analysis'
import { useAssets } from '@/store/assets'
import { useBackend } from '@/store/backend'
import { useProject } from '@/store/project'
import styles from './Inspector.module.css'

/** Параметры и запуск анализа музыки аудиоклипа (CONTRACT §4): cutoff, sensitivity, minGap, useStems. */
export function AnalysisPanel({ clipId }: { clipId: string }) {
  const clip = useProject((s) => findClip(s.project, clipId)?.clip)
  const asset = useAssets((s) => (clip ? s.assets[clip.assetId] : undefined))
  const result = useAnalysis((s) => (clip ? s.results[clip.assetId] : undefined))
  const running = useAnalysis((s) => s.running[clipId])
  const error = useAnalysis((s) => s.errors[clipId])
  const progress = useAssets((s) => (running?.jobId ? s.jobs[running.jobId]?.progress : undefined))
  const aiRunning = useAnalysis((s) => s.aiRunning[clipId])
  const gemini = useBackend((s) => s.health?.gemini)
  const [params, setParams] = useState<MusicAnalysisParams>(result?.params ?? DEFAULT_ANALYSIS_PARAMS)
  const [dirty, setDirty] = useState(false)
  if (!clip) return null

  const autoCount = clip.markers.filter((m) => AUTO_KINDS.includes(m.kind)).length
  const manualCount = clip.markers.length - autoCount
  const analyzed = autoCount > 0
  const patch = (p: Partial<MusicAnalysisParams>) => {
    setParams((cur) => ({ ...cur, ...p }))
    setDirty(true)
  }
  const run = () => void useAnalysis.getState().analyze(clipId, analyzed || dirty ? { params } : {})

  return (
    <section className={styles.section} data-testid="analysis-panel" aria-label="Анализ музыки">
      <h3 className={styles.heading}>Анализ музыки</h3>
      <div className={styles.meta}>
        {asset?.name ?? clip.assetId}
        {result && <span data-testid="analysis-bpm"> · {Math.round(result.bpm * 10) / 10} BPM</span>}
      </div>
      <div className={styles.meta} data-testid="analysis-counts">
        {analyzed ? `Маркеров: ${autoCount} авто` : 'Не проанализировано'}
        {manualCount > 0 && `, ${manualCount} вручную`}
        {clip.sections && clip.sections.length > 0 && ` · секций: ${clip.sections.length}`}
      </div>

      <Row label={`Басы до ${params.bassCutoffHz} Гц`}>
        <input
          type="range"
          min={40}
          max={400}
          step={5}
          value={params.bassCutoffHz}
          onChange={(e) => patch({ bassCutoffHz: Number(e.currentTarget.value) })}
          data-testid="param-cutoff"
        />
      </Row>
      <Row label={`Чувствительность ${params.sensitivity.toFixed(2)}`}>
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={params.sensitivity}
          onChange={(e) => patch({ sensitivity: Number(e.currentTarget.value) })}
          data-testid="param-sensitivity"
        />
      </Row>
      <Row label={`Мин. интервал ${params.minGapSec.toFixed(2)} с`}>
        <input
          type="range"
          min={0.02}
          max={1}
          step={0.01}
          value={params.minGapSec}
          onChange={(e) => patch({ minGapSec: Number(e.currentTarget.value) })}
          data-testid="param-mingap"
        />
      </Row>
      <label className={styles.check}>
        <input
          type="checkbox"
          checked={params.useStems}
          onChange={(e) => patch({ useStems: e.currentTarget.checked })}
          data-testid="param-stems"
        />
        Разделить на стемы (Demucs, дольше)
      </label>

      <button className={styles.primary} disabled={!!running} onClick={run} data-testid="analyze-button">
        {running ? 'Анализ…' : analyzed ? 'Переанализировать' : 'Анализировать'}
      </button>
      {running && (
        <div className={styles.bar} data-testid="analysis-progress">
          <div className={styles.fill} style={{ width: `${Math.round((progress ?? 0) * 100)}%` }} />
        </div>
      )}
      {analyzed && (
        <button
          disabled={!!aiRunning || !!running || gemini === false}
          onClick={() => void useAnalysis.getState().aiSections(clipId)}
          title={
            gemini === false
              ? 'Ключ Gemini не задан на бэке'
              : 'Gemini подпишет секции: вступление, дроп, брейк…'
          }
          data-testid="ai-sections-button"
        >
          {aiRunning ? 'ИИ слушает трек…' : 'ИИ-разметка секций'}
        </button>
      )}
      {clip.sections?.some((s) => s.description) && (
        <ul className={styles.hint} data-testid="ai-sections">
          {clip.sections.map((s) => (
            <li key={s.id}>
              {s.label}: {s.description ?? '—'}
            </li>
          ))}
        </ul>
      )}
      {error && <div className={styles.error}>{error}</div>}
      {analyzed && (
        <div className={styles.hint}>Ручные и ИИ-маркеры сохраняются, автоматические заменяются.</div>
      )}
    </section>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className={styles.row}>
      <span>{label}</span>
      {children}
    </label>
  )
}
