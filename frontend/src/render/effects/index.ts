// Реестр модулей эффектов рендера. Эффект реестра без модуля (glow, переходы — фаза 4b) рендерер пропускает.
import { cameraEffects } from './camera'
import { colorEffects } from './color'
import { distortEffects } from './distort'
import { lightEffects } from './light'
import { stylizeEffects } from './stylize'
import type { EffectModule } from './types'

export type { EffectFrame, EffectModule } from './types'

export const EFFECT_MODULES: ReadonlyMap<string, EffectModule> = new Map(
  [...cameraEffects, ...lightEffects, ...colorEffects, ...distortEffects, ...stylizeEffects].map((m) => [
    m.id,
    m,
  ]),
)

export function hasRenderer(effectId: string): boolean {
  return EFFECT_MODULES.has(effectId)
}
