// Эффекты в проекте: новый эффект по реестру, бросок эффекта из библиотеки на таймлайн.
// Чистые функции: проект не меняют, возвращают ops.
import type { EditOp, EffectInput, Project } from '@/shared/types.gen'
import { getEffectDef } from '@/shared/effects-registry'
import { EPS, itemEnd } from './clipTime'
import { findClip, findTrack } from './lookup'
import { OpsError } from './ops/errors'
import { trackInput } from './project'

/** Эффект с дефолтами реестра (`params` пустые — значения берутся из реестра, CONTRACT §2.1). */
export function newEffectInput(effectId: string, start: number, duration?: number): EffectInput {
  const def = getEffectDef(effectId)
  if (!def) throw new OpsError('unknown_effect', `Неизвестный эффект ${effectId}`)
  return {
    effect: effectId,
    start,
    duration: duration ?? def.defaultDuration,
    params: {},
    envelope: { ...def.defaultEnvelope },
    enabled: true,
  }
}

export type EffectDropTarget = { clipId: string } | { trackId: string } | 'newFxTrack'

/**
 * Эффект из библиотеки брошен на таймлайн в момент `t`:
 * - на клип видеодорожки — в `clip.effects` с начала в точке броска (обрезается по концу клипа);
 * - на fx-дорожку — элемент дорожки; длительность урезается до следующего элемента, в занятое место нельзя;
 * - иначе — на новую fx-дорожку поверх всех.
 */
export function planEffectDrop(p: Project, effectId: string, target: EffectDropTarget, t: number): EditOp[] {
  const def = getEffectDef(effectId)
  if (!def) throw new OpsError('unknown_effect', `Неизвестный эффект ${effectId}`)
  const frame = 1 / p.fps
  const at = Math.max(0, t)

  if (target === 'newFxTrack') {
    const id = 'tmp_dropfx'
    return [
      { op: 'addTrack', track: { ...trackInput(p, 'fx', id), name: `FX: ${def.name}` } },
      { op: 'addEffect', target: { trackId: id }, effect: newEffectInput(effectId, at) },
    ]
  }

  if ('clipId' in target) {
    const ref = findClip(p, target.clipId)
    if (!ref) throw new OpsError('clip_not_found', `Клип ${target.clipId} не найден`)
    if (ref.track.kind !== 'video') throw new OpsError('incompatible_track', 'Эффекты кладутся на видеоклипы')
    const clip = ref.clip
    const start = Math.min(Math.max(at - clip.start, 0), Math.max(0, clip.duration - frame))
    const duration = Math.min(def.defaultDuration, clip.duration - start)
    return [
      { op: 'addEffect', target: { clipId: clip.id }, effect: newEffectInput(effectId, start, duration) },
    ]
  }

  const track = findTrack(p, target.trackId)
  if (!track) throw new OpsError('track_not_found', `Дорожка ${target.trackId} не найдена`)
  if (track.kind !== 'fx')
    throw new OpsError('incompatible_track', 'Эффект можно положить только на fx-дорожку')
  if (track.items.some((it) => at >= it.start - EPS && at < itemEnd(it) - EPS)) {
    throw new OpsError('slots_overlap', 'Место на fx-дорожке занято')
  }
  const next = track.items.find((it) => it.start > at + EPS)
  const duration = Math.min(def.defaultDuration, next ? next.start - at : Infinity)
  if (duration < frame - EPS) throw new OpsError('slots_overlap', 'Не хватает места до следующего эффекта')
  return [{ op: 'addEffect', target: { trackId: track.id }, effect: newEffectInput(effectId, at, duration) }]
}
