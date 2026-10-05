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

export interface EffectModule {
  id: string
  /** Фрагментный шейдер без заголовка: свои uniform + `void main()`, пишет `o_color`. */
  fragment: string
  uniforms?(f: EffectFrame): Record<string, UniformValue>
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

/** Половина кадра «выдержки» для motion blur, сек. */
export function shutter(fps: number): number {
  return 0.5 / fps
}
