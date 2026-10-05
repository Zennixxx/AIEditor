// Эндпоинты ассетов (CONTRACT §8). Компоненты обращаются к API только через store/.
import type { Asset, ImportResponse, Thumbs, Waveform } from '@/shared/types.gen'
import { api, apiUrl } from './client'

export const assetsApi = {
  list: () => api.get<Asset[]>('/assets'),
  /** Браузерный режим: файлы копируются бэком в data/uploads. */
  upload: (files: readonly File[]) => {
    const form = new FormData()
    for (const f of files) form.append('files', f, f.name)
    return api.post<ImportResponse>('/assets/upload', form)
  },
  /** Tauri (фаза 8): импорт по абсолютным путям. */
  importPaths: (paths: readonly string[]) => api.post<ImportResponse>('/assets/import', { paths }),
  thumbs: (url: string) => api.get<Thumbs>(url),
  waveform: (url: string) => api.get<Waveform>(url),
  /** Абсолютный URL производного файла (для <img>/<video>). */
  fileUrl: (url: string) => apiUrl(url),
}
