// ИИ-эндпоинты (CONTRACT §8, §8.4–8.7). Компоненты обращаются к API только через store/.
import type {
  AICommandRequest,
  AutoEditRequest,
  ClipAnalysis,
  JobRef,
  OpsResult,
  StylePreset,
} from '@/shared/types.gen'
import { api, ApiError } from './client'

export const aiApi = {
  command: (req: AICommandRequest, signal?: AbortSignal) => api.post<OpsResult>('/ai/command', req, signal),
  /** Задача kind `clipAnalysis` → `ClipAnalysis`. */
  analyzeClip: (assetId: string, force = false) =>
    api.post<JobRef>(`/ai/analyze-clip/${assetId}`, force ? { force } : {}),
  /** Задача kind `aiMusic` → `MusicAnalysis` с подписанными секциями. */
  analyzeMusic: (assetId: string) => api.post<JobRef>(`/ai/analyze-music/${assetId}`),
  /** Задача kind `autoEdit` → `OpsResult`. */
  autoEdit: (req: AutoEditRequest) => api.post<JobRef>('/ai/auto-edit', req),
  /** Задача kind `styleRef` → `StylePreset`. */
  styleFromReference: (assetId: string) => api.post<JobRef>(`/ai/style-from-reference/${assetId}`),
  userStyles: () => api.get<StylePreset[]>('/presets/styles'),
  /** Локальный или ИИ-анализ клипа, null — ещё не выполнен (404). */
  getClipAnalysis: async (assetId: string): Promise<ClipAnalysis | null> => {
    try {
      return await api.get<ClipAnalysis>(`/analysis/clip/${assetId}`)
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return null
      throw e
    }
  },
}
