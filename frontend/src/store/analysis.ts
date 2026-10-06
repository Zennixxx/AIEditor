// Анализ музыки: запуск на бэке, ожидание задачи, перенос результата в проект одной транзакцией ops (CONTRACT §4).
import { create } from 'zustand'
import { analysisApi } from '@/api/analysis'
import { ApiError } from '@/api/client'
import { canHoldAnalysis, planApplyAnalysis } from '@/model/markers'
import { findClip } from '@/model/lookup'
import type { MusicAnalysis, MusicAnalysisParamsInput } from '@/shared/types.gen'
import { waitForJob } from './jobWait'
import { useProject } from './project'

export interface AnalyzeOptions {
  /** Параметры анализа: если заданы — анализ всегда запускается заново («Переанализировать»). */
  params?: MusicAnalysisParamsInput
}

interface AnalysisState {
  /** clipId → задача анализа (jobId появляется после ответа POST). */
  running: Record<string, { jobId: string | null }>
  /** assetId → последний полученный анализ (BPM, параметры) — для инспектора. */
  results: Record<string, MusicAnalysis>
  /** clipId → сообщение об ошибке последнего анализа. */
  errors: Record<string, string>
  analyze: (clipId: string, opts?: AnalyzeOptions) => Promise<boolean>
}

const isMusicAnalysis = (x: unknown): x is MusicAnalysis =>
  typeof x === 'object' && x !== null && 'bass' in x && 'sections' in x && 'beats' in x

/** Ждёт завершения задачи `musicAnalysis`: по WS-событиям (стор задач) и опросом. Возвращает результат. */
async function awaitMusicJob(jobId: string): Promise<MusicAnalysis> {
  const job = await waitForJob(jobId)
  if (!isMusicAnalysis(job.result)) throw new Error('Бэк не вернул результат анализа')
  return job.result
}

function messageOf(e: unknown): string {
  if (e instanceof ApiError || e instanceof Error) return e.message
  return 'Не удалось выполнить анализ'
}

export const useAnalysis = create<AnalysisState>()((set, get) => ({
  running: {},
  results: {},
  errors: {},

  analyze: async (clipId, opts = {}) => {
    if (get().running[clipId]) return false
    const ref = findClip(useProject.getState().project, clipId)
    if (!ref || !canHoldAnalysis(useProject.getState().project, clipId)) return false
    const assetId = ref.clip.assetId
    set((s) => ({ running: { ...s.running, [clipId]: { jobId: null } }, errors: omit(s.errors, clipId) }))
    try {
      // уже готовый анализ ассета применяется сразу, без новой задачи
      let analysis = opts.params ? null : await analysisApi.getMusic(assetId)
      if (!analysis) {
        const { jobId } = await analysisApi.startMusic(assetId, opts.params ?? {})
        set((s) => ({ running: { ...s.running, [clipId]: { jobId } } }))
        analysis = await awaitMusicJob(jobId)
      }
      const project = useProject.getState().project
      const ops = planApplyAnalysis(project, clipId, analysis) // клип мог исчезнуть за время анализа → []
      const res = useProject.getState().dispatch(ops, { label: 'Анализ музыки' })
      set((s) => ({ results: { ...s.results, [assetId]: analysis } }))
      if (!res.ok) throw new Error(res.error.message)
      return ops.length > 0
    } catch (e) {
      set((s) => ({ errors: { ...s.errors, [clipId]: messageOf(e) } }))
      return false
    } finally {
      set((s) => ({ running: omit(s.running, clipId) }))
    }
  },
}))

function omit<T>(obj: Record<string, T>, key: string): Record<string, T> {
  const { [key]: _removed, ...rest } = obj
  return rest
}

/** Автоанализ при добавлении аудиоклипов на таймлайн (клипы аудиодорожек без маркеров). */
export function autoAnalyzeClips(clipIds: readonly string[]): void {
  const project = useProject.getState().project
  for (const id of clipIds) {
    const ref = findClip(project, id)
    if (!ref || ref.track.kind !== 'audio' || ref.clip.markers.length > 0) continue
    void useAnalysis.getState().analyze(id)
  }
}
