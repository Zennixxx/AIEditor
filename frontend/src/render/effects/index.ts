// Реестр модулей эффектов рендера. Эффект реестра без модуля рендерер пропускает (тест: модули есть у всех).
import { cameraEffects } from './camera'
import { colorEffects } from './color'
import { distortEffects } from './distort'
import { lightEffects } from './light'
import { stylizeEffects } from './stylize'
import { transitionEffects } from './transition'
import type { EffectModule } from './types'

export { effectStages } from './types'
export type { EffectFrame, EffectModule, EffectStage } from './types'

export const EFFECT_MODULES: ReadonlyMap<string, EffectModule> = new Map(
  [
    ...cameraEffects,
    ...lightEffects,
    ...colorEffects,
    ...distortEffects,
    ...stylizeEffects,
    ...transitionEffects,
  ].map((m) => [m.id, m]),
)

export function hasRenderer(effectId: string): boolean {
  return EFFECT_MODULES.has(effectId)
}
