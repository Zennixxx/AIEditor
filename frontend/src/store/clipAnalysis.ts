// Анализ клипов (CONTRACT §4, §8.5): локальный (движение, склейки) и ИИ (моменты, крупность планов).
// Используется для полосок моментов на таймлайне и `cutToMarkers` с `order: "bestMoments"`.
import { create } from 'zustand'
import { aiApi } from '@/api/ai'
import { ApiError } from '@/api/client'
import type { ClipAnalysis } from '@/shared/types.gen'
import { waitForJob } from './jobWait'

interface ClipAnalysisState {
  byAsset: Record<string, ClipAnalysis>
  /** assetId → задача ИИ-анализа (jobId появляется после ответа POST). */
  running: Record<string, { jobId: string | null }>
  errors: Record<string, string>
  put: (analysis: ClipAnalysis) => void
  load: (assetId: string) => Promise<void>
  analyze: (assetId: string, force?: boolean) => Promise<boolean>
}

export const isClipAnalysis = (x: unknown): x is ClipAnalysis =>
  typeof x === 'object' && x !== null && 'moments' in x && 'shots' in x && 'motion' in x

function messageOf(e: unknown): string {
  if (e instanceof ApiError && e.code === 'gemini_not_configured') return 'Ключ Gemini не задан на бэке'
  if (e instanceof Error) return e.message
  return 'Не удалось проанализировать клип'
}

const loading = new Set<string>()

export const useClipAnalysis = create<ClipAnalysisState>()((set, get) => ({
  byAsset: {},
  running: {},
  errors: {},

  put: (analysis) => set((s) => ({ byAsset: { ...s.byAsset, [analysis.assetId]: analysis } })),

  load: async (assetId) => {
    if (loading.has(assetId) || get().byAsset[assetId]) return
    loading.add(assetId)
    try {
      const analysis = await aiApi.getClipAnalysis(assetId)
      if (analysis) get().put(analysis)
    } catch {
      // анализ — дополнительная информация, ошибки загрузки не показываем
    } finally {
      loading.delete(assetId)
    }
  },

  analyze: async (assetId, force = false) => {
    if (get().running[assetId]) return false
    set((s) => ({ running: { ...s.running, [assetId]: { jobId: null } }, errors: omit(s.errors, assetId) }))
    try {
      const { jobId } = await aiApi.analyzeClip(assetId, force)
      set((s) => ({ running: { ...s.running, [assetId]: { jobId } } }))
      const job = await waitForJob(jobId)
      if (!isClipAnalysis(job.result)) throw new Error('Бэк не вернул анализ клипа')
      get().put(job.result)
      return true
    } catch (e) {
      set((s) => ({ errors: { ...s.errors, [assetId]: messageOf(e) } }))
      return false
    } finally {
      set((s) => ({ running: omit(s.running, assetId) }))
    }
  },
}))

function omit<T>(obj: Record<string, T>, key: string): Record<string, T> {
  const { [key]: _removed, ...rest } = obj
  return rest
}

export function clipAnalysisOf(assetId: string): ClipAnalysis | undefined {
  return useClipAnalysis.getState().byAsset[assetId]
}
