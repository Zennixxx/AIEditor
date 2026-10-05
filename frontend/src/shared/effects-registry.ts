import type { EffectCategory, EffectDef, EffectParams, EffectsRegistry } from '@/shared/types.gen'
import registryJson from '@shared/effects.json'

export const effectsRegistry = registryJson as EffectsRegistry

const byId = new Map<string, EffectDef>(effectsRegistry.effects.map((e) => [e.id, e]))

export function getEffectDef(id: string): EffectDef | undefined {
  return byId.get(id)
}

export function effectsByCategory(): Map<EffectCategory, EffectDef[]> {
  const res = new Map<EffectCategory, EffectDef[]>()
  for (const e of effectsRegistry.effects) {
    const list = res.get(e.category) ?? []
    list.push(e)
    res.set(e.category, list)
  }
  return res
}

/** Параметры по умолчанию из реестра, поверх — переданные. */
export function defaultParams(id: string, overrides: EffectParams = {}): EffectParams {
  const def = byId.get(id)
  if (!def) throw new Error(`Unknown effect: ${id}`)
  const params: EffectParams = {}
  for (const p of def.params) params[p.key] = p.default
  return { ...params, ...overrides }
}

export const CATEGORY_LABELS: Record<EffectCategory, string> = {
  camera: 'Камера',
  light: 'Свет',
  color: 'Цвет',
  distort: 'Искажения',
  stylize: 'Стиль',
  transition: 'Переходы',
}
