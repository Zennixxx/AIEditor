// Настройки редактора (браузер, localStorage): качество превью.
import { create } from 'zustand'

export type PreviewQuality = 1 | 0.5 | 0.25

export const PREVIEW_QUALITIES: { value: PreviewQuality; label: string }[] = [
  { value: 1, label: 'Полное' },
  { value: 0.5, label: '½' },
  { value: 0.25, label: '¼' },
]

const QUALITY_KEY = 'aieditor.previewQuality'

function readQuality(): PreviewQuality {
  try {
    const v = Number(localStorage.getItem(QUALITY_KEY))
    return v === 0.5 || v === 0.25 ? v : 1
  } catch {
    return 1
  }
}

interface SettingsState {
  previewQuality: PreviewQuality
  setPreviewQuality: (q: PreviewQuality) => void
}

export const useSettings = create<SettingsState>()((set) => ({
  previewQuality: readQuality(),
  setPreviewQuality: (previewQuality) => {
    set({ previewQuality })
    try {
      localStorage.setItem(QUALITY_KEY, String(previewQuality))
    } catch {
      // без localStorage настройка живёт до перезагрузки
    }
  },
}))
