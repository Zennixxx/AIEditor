// Модуль эффекта (FRONTEND.md §4.1): шейдер + вычисление его uniform на кадр.
// Рендерер даёт стандартные uniform (FRAGMENT_HEADER в gl.ts): u_tex, u_res, u_intensity, u_time,
// u_seed, u_frame, u_px. Все эффекты — тождество при u_intensity = 0.
import type { EffectParams } from '@/shared/types.gen'
import type { EffectPass } from '../framePlan'
import type { UniformValue } from '../gl'

export interface EffectFrame {
  pass: EffectPass
  fps: number
  /** Номер кадра проекта. */
  frame: number
  /** Размер цели, px. */
  res: readonly [number, number]
  /** Пикселей цели на пиксель проекта (параметры в px заданы в пикселях проекта). */
  px: number
}

export interface EffectStage {
  /** Фрагментный шейдер без заголовка: свои uniform + `void main()`, пишет `o_color`. */
  fragment: string
  uniforms?(f: EffectFrame): Record<string, UniformValue>
}

/**
 * Однопроходный эффект — `fragment` (+ `uniforms`). Многопроходный (glow) — `stages`: проход `i` читает
 * результат прохода `i − 1` из `u_tex`, исходный кадр эффекта — из `u_src`.
 */
export interface EffectModule extends Partial<EffectStage> {
  id: string
  stages?: readonly EffectStage[]
}

/** Проходы модуля по порядку. */
export function effectStages(m: EffectModule): readonly EffectStage[] {
  if (m.stages) return m.stages
  return m.fragment ? [{ fragment: m.fragment, ...(m.uniforms ? { uniforms: m.uniforms } : {}) }] : []
}

export function num(p: EffectParams, key: string, fallback = 0): number {
  const v = p[key]
  return typeof v === 'number' ? v : fallback
}

export function bool(p: EffectParams, key: string): boolean {
  return p[key] === true
}

export function str(p: EffectParams, key: string, fallback = ''): string {
  const v = p[key]
  return typeof v === 'string' ? v : fallback
}

/** Положение внутри эффекта 0..1 (у перехода стык — в 0.5). */
export function progress(pass: EffectPass): number {
  const d = pass.item.duration
  return d > 0 ? Math.min(Math.max(pass.tau / d, 0), 1) : 0
}

/** Половина кадра «выдержки» для motion blur, сек. */
export function shutter(fps: number): number {
  return 0.5 / fps
}
