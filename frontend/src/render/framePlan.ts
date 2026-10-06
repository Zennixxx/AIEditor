// План кадра в момент timeline time T (FRONTEND.md §4.1): что и в каком порядке рендерить.
// Чистая функция без GL — общая для превью и экспорта, покрыта тестами.
//
//   1. дорожки снизу вверх; видеодорожка: клип под T → src = timeRemap(T) → transform (ключи) →
//      эффекты клипа по порядку → смешение в аккумулятор по blendMode/opacity;
//   2. fx-дорожка: её активные эффекты применяются к аккумулятору (adjustment layer, CONTRACT §2 п. 7).
import { effectIntensity } from '@/model/envelope'
import { layerBlend, type FrameBlend } from '@/model/interpolation'
import { evaluateAnimatable } from '@/model/keyframes'
import { layerAt, clipAt, type AssetLookup } from '@/playback/timing'
import { resolveParams } from '@/shared/effects-registry'
import type { Clip, EffectItem, EffectParams, Project } from '@/shared/types.gen'
import type { LayerTransform } from './layerMath'
import { effectSeed } from './noise'

export interface EffectPass {
  item: EffectItem
  /** Полный набор параметров (дефолты реестра + заданные). */
  params: EffectParams
  /** Огибающая × strength в момент кадра. */
  intensity: number
  /** Время от начала эффекта, сек. */
  tau: number
  seed: number
}

export interface LayerStep {
  kind: 'layer'
  trackId: string
  clip: Clip
  /** Время от начала клипа. */
  local: number
  /** Source time кадра. */
  src: number
  transform: LayerTransform
  opacity: number
  blendMode: Clip['blendMode']
  effects: EffectPass[]
  blend: FrameBlend | null
}

export interface AdjustStep {
  kind: 'adjust'
  trackId: string
  effects: EffectPass[]
}

export type PlanStep = LayerStep | AdjustStep

export interface FramePlan {
  time: number
  /** Номер кадра проекта: round(T · fps) — сид шума, меняющегося каждый кадр. */
  frame: number
  fps: number
  width: number
  height: number
  background: string
  steps: PlanStep[]
}

/** Активный эффект в момент `tau` от его начала или null (выключен / вне длительности / нулевая интенсивность). */
export function effectPass(item: EffectItem, tau: number): EffectPass | null {
  if (!item.enabled || !(tau >= 0 && tau < item.duration)) return null
  const intensity = effectIntensity(item, tau)
  if (!(intensity > 0)) return null
  return { item, params: resolveParams(item.effect, item.params), intensity, tau, seed: effectSeed(item.id) }
}

export function buildFramePlan(project: Project, T: number, lookup?: AssetLookup): FramePlan {
  const steps: PlanStep[] = []
  for (const track of project.tracks) {
    if (track.hidden) continue
    if (track.kind === 'video') {
      const clip = clipAt(track, T)
      if (!clip) continue
      const layer = layerAt(track, clip, T)
      const opacity = Math.min(Math.max(evaluateAnimatable(clip.opacity, layer.local), 0), 1)
      if (opacity <= 0) continue
      const tr = clip.transform
      const effects: EffectPass[] = []
      for (const e of clip.effects) {
        const pass = effectPass(e, layer.local - e.start)
        if (pass) effects.push(pass)
      }
      steps.push({
        kind: 'layer',
        trackId: track.id,
        clip,
        local: layer.local,
        src: layer.src,
        transform: {
          x: evaluateAnimatable(tr.x, layer.local),
          y: evaluateAnimatable(tr.y, layer.local),
          scale: evaluateAnimatable(tr.scale, layer.local),
          rotation: evaluateAnimatable(tr.rotation, layer.local),
          anchorX: tr.anchorX,
          anchorY: tr.anchorY,
        },
        opacity,
        blendMode: clip.blendMode,
        effects,
        blend: layerBlend(clip, layer.src, layer.rate, lookup),
      })
    } else if (track.kind === 'fx') {
      const effects: EffectPass[] = []
      for (const item of track.items) {
        if (item.type !== 'effect') continue
        if (item.start > T) break // отсортированы по start
        const pass = effectPass(item, T - item.start)
        if (pass) effects.push(pass)
      }
      if (effects.length > 0) steps.push({ kind: 'adjust', trackId: track.id, effects })
    }
  }
  return {
    time: T,
    frame: Math.round(T * project.fps),
    fps: project.fps,
    width: project.width,
    height: project.height,
    background: project.background,
    steps,
  }
}
