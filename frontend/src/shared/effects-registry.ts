import type {
  EffectCategory,
  EffectDef,
  EffectParamDef,
  EffectParams,
  EffectsRegistry,
} from '@/shared/types.gen'
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

const resolvedCache = new WeakMap<EffectParams, EffectParams>()

/**
 * Полный набор параметров эффекта: отсутствующие ключи — дефолты реестра (CONTRACT §2.1).
 * Кэшируется по объекту `params` (в проекте он неизменяемый — Immer), чтобы рендер не аллоцировал в кадре.
 */
export function resolveParams(id: string, params: EffectParams): EffectParams {
  const cached = resolvedCache.get(params)
  if (cached) return cached
  const def = byId.get(id)
  const res: EffectParams = {}
  if (def) for (const p of def.params) res[p.key] = p.default
  Object.assign(res, params)
  resolvedCache.set(params, res)
  return res
}

const COLOR_RE = /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/

/** Почему значение не подходит параметру (null — подходит). Те же правила, что у бэка (`effects/registry.py`). */
export function paramValueError(p: EffectParamDef, value: unknown): string | null {
  switch (p.type) {
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) return 'ожидается число'
      if ((p.min !== undefined && value < p.min) || (p.max !== undefined && value > p.max))
        return `вне диапазона ${p.min ?? '−∞'}..${p.max ?? '∞'}`
      return null
    case 'boolean':
      return typeof value === 'boolean' ? null : 'ожидается boolean'
    case 'color':
      return typeof value === 'string' && COLOR_RE.test(value) ? null : 'ожидается цвет #rrggbb'
    case 'enum':
      return typeof value === 'string' && (p.options ?? []).includes(value)
        ? null
        : `допустимо: ${(p.options ?? []).join(', ')}`
  }
}

/** Ошибки параметров по реестру: неизвестный эффект, неизвестный ключ, значение не по типу/диапазону. */
export function paramErrors(id: string, params: Record<string, unknown>): string[] {
  const def = byId.get(id)
  if (!def) return [`неизвестный эффект ${id}`]
  const errors: string[] = []
  for (const [key, value] of Object.entries(params)) {
    const p = def.params.find((x) => x.key === key)
    if (!p) {
      errors.push(`у эффекта ${id} нет параметра ${key}`)
      continue
    }
    const err = paramValueError(p, value)
    if (err) errors.push(`${id}.${key} = ${JSON.stringify(value)}: ${err}`)
  }
  return errors
}

export const CATEGORY_LABELS: Record<EffectCategory, string> = {
  camera: 'Камера',
  light: 'Свет',
  color: 'Цвет',
  distort: 'Искажения',
  stylize: 'Стиль',
  transition: 'Переходы',
}
