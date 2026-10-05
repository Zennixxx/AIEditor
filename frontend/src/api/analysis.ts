// Эндпоинты анализа музыки и задач (CONTRACT §4, §8). Компоненты обращаются к API только через store/.
import type { Job, JobRef, MusicAnalysis, MusicAnalysisParamsInput } from '@/shared/types.gen'
import { api, ApiError } from './client'

export const analysisApi = {
  /** Готовый анализ ассета или null (404). */
  getMusic: async (assetId: string): Promise<MusicAnalysis | null> => {
    try {
      return await api.get<MusicAnalysis>(`/analysis/music/${assetId}`)
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return null
      throw e
    }
  },
  /** Запуск анализа: задача kind `musicAnalysis`, результат — `MusicAnalysis`. */
  startMusic: (assetId: string, params: MusicAnalysisParamsInput = {}) =>
    api.post<JobRef>(`/analysis/music/${assetId}`, params),
}

export const jobsApi = {
  get: (jobId: string) => api.get<Job>(`/jobs/${jobId}`),
}
