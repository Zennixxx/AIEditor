// Огибающая и интенсивность эффекта (CONTRACT §2.1) — одна формула для превью и экспорта.
import type { EffectItem, Envelope } from '@/shared/types.gen'
import { resolveParams } from '@/shared/effects-registry'

const K = 5
const EXP_NORM = 1 - Math.exp(-K)

function up(curve: Envelope['curve'], p: number): number {
  switch (curve) {
    case 'linear':
      return p
    case 'easeOut':
      return 1 - (1 - p) * (1 - p)
    case 'exp':
      return (1 - Math.exp(-K * p)) / EXP_NORM
  }
}

function down(curve: Envelope['curve'], q: number): number {
  switch (curve) {
    case 'linear':
      return 1 - q
    case 'easeOut':
      return (1 - q) * (1 - q)
    case 'exp':
      return (Math.exp(-K * q) - Math.exp(-K)) / EXP_NORM
  }
}

/** Огибающая 0..1 в момент `tau` от начала эффекта длительностью `duration`; вне [0, duration) — 0. */
export function envelopeAt(env: Envelope, duration: number, tau: number): number {
  if (!(tau >= 0 && tau < duration)) return 0
  const a = Math.min(Math.max(env.attack, 0), duration)
  const h = Math.min(Math.max(env.hold, 0), duration - a)
  const r = Math.min(Math.max(env.decay, 0), duration - a - h)
  if (tau < a) return up(env.curve, tau / a)
  if (tau < a + h) return 1
  if (tau < a + h + r) return down(env.curve, (tau - a - h) / r)
  return 0
}

/** Интенсивность эффекта: огибающая × параметр `strength` (дефолт реестра; у переходов — 1). */
export function effectIntensity(
  item: Pick<EffectItem, 'effect' | 'params' | 'envelope' | 'duration'>,
  tau: number,
): number {
  const env = envelopeAt(item.envelope, item.duration, tau)
  if (env === 0) return 0
  const strength = resolveParams(item.effect, item.params).strength
  return env * (typeof strength === 'number' ? strength : 1)
}
