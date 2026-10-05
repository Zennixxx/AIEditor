// Пресеты-комбо эффектов с бэка (GET/POST /presets). Не часть проекта и истории.
import { create } from 'zustand'
import { ApiError } from '@/api/client'
import { presetsApi } from '@/api/presets'
import type { CreateEffectPresetRequest, EffectPreset } from '@/shared/types.gen'

interface PresetsState {
  presets: EffectPreset[]
  status: 'idle' | 'loading' | 'ready' | 'error'
  error: string | null
  load: () => Promise<void>
  /** Сохранить пресет; null — ошибка (текст — в `error`). */
  create: (body: CreateEffectPresetRequest) => Promise<EffectPreset | null>
}

function message(e: unknown): string {
  if (!(e instanceof ApiError)) return 'Неизвестная ошибка'
  const errors = e.details?.errors
  return Array.isArray(errors) && errors.length > 0 ? `${e.message}: ${errors.join('; ')}` : e.message
}

export const usePresets = create<PresetsState>()((set, get) => ({
  presets: [],
  status: 'idle',
  error: null,

  load: async () => {
    if (get().status === 'loading') return
    set({ status: 'loading', error: null })
    try {
      set({ presets: await presetsApi.list(), status: 'ready' })
    } catch (e) {
      set({ status: 'error', error: message(e) })
    }
  },

  create: async (body) => {
    try {
      const preset = await presetsApi.create(body)
      set((s) => ({ presets: [...s.presets, preset], error: null }))
      return preset
    } catch (e) {
      set({ error: message(e) })
      return null
    }
  },
}))

export function findPreset(id: string): EffectPreset | undefined {
  return usePresets.getState().presets.find((p) => p.id === id)
}
