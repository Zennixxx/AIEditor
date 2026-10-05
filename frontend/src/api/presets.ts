// Пресеты-комбо эффектов (CONTRACT §8: GET/POST /presets).
import type { CreateEffectPresetRequest, EffectPreset } from '@/shared/types.gen'
import { api } from './client'

export const presetsApi = {
  list: () => api.get<EffectPreset[]>('/presets'),
  create: (body: CreateEffectPresetRequest) => api.post<EffectPreset>('/presets', body),
}
