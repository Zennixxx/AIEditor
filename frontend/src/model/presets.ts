// Пресеты-комбо эффектов (CONTRACT §8: EffectPreset): сохранить набор эффектов выделения, применить пресет.
// Чистые функции: проект не меняют, возвращают данные пресета или ops.
import type { EditOp, EffectInput, EffectPreset, PresetEffect, Project, Track } from '@/shared/types.gen'
import { EPS, itemEnd } from './clipTime'
import type { EffectDropTarget } from './effects'
import { findClip, findEffect, findItem, findTrack, isClip, isEffect } from './lookup'
import { OpsError } from './ops/errors'
import { trackInput } from './project'

/**
 * Эффекты выделения для пресета: выделенные элементы fx-дорожек и все эффекты выделенных клипов;
 * если таких нет — эффект клипа, раскрытый в инспекторе. Время — от самого раннего из них.
 */
export function presetEffectsFromSelection(
  p: Project,
  selection: readonly string[],
  inspectedEffectId?: string | null,
): PresetEffect[] {
  const found: { at: number; e: PresetEffect }[] = []
  const add = (at: number, e: PresetEffect) => found.push({ at, e })
  for (const id of new Set(selection)) {
    const ref = findItem(p, id)
    if (!ref) continue
    if (isEffect(ref.item)) add(ref.item.start, toPresetEffect(ref.item))
    else for (const e of ref.item.effects) add(ref.item.start + e.start, toPresetEffect(e))
  }
  if (found.length === 0 && inspectedEffectId) {
    const ref = findEffect(p, inspectedEffectId)
    if (ref) add((ref.clip?.start ?? 0) + ref.effect.start, toPresetEffect(ref.effect))
  }
  if (found.length === 0) return []
  const origin = Math.min(...found.map((f) => f.at))
  return found.sort((a, b) => a.at - b.at).map(({ at, e }) => ({ ...e, start: round6(at - origin) }))
}

function toPresetEffect(e: Pick<PresetEffect, 'effect' | 'duration' | 'params' | 'envelope'>): PresetEffect {
  return {
    effect: e.effect,
    start: 0,
    duration: e.duration,
    params: structuredClone(e.params),
    envelope: { ...e.envelope },
  }
}

function round6(v: number): number {
  return Math.round(v * 1e6) / 1e6
}

/** Длительность пресета: конец самого позднего эффекта. */
export function presetSpan(preset: Pick<EffectPreset, 'effects'>): number {
  return Math.max(0, ...preset.effects.map((e) => e.start + e.duration))
}

function effectInput(e: PresetEffect, start: number, duration: number): EffectInput {
  return {
    effect: e.effect,
    start,
    duration,
    params: structuredClone(e.params),
    envelope: { ...e.envelope },
    enabled: true,
  }
}

function overlaps(a: { start: number; end: number }, b: { start: number; end: number }): boolean {
  return a.start < b.end - EPS && b.start < a.end - EPS
}

/**
 * Применить пресет в момент `t`:
 * - на клип видеодорожки — эффекты в `clip.effects` со сдвигом от точки броска (не дальше конца клипа);
 * - на fx-дорожку или «новую fx-дорожку» — элементы дорожек: эффекты, которые перекрываются по времени,
 *   раскладываются по слоям; первый слой — выбранная fx-дорожка (если место свободно), остальные —
 *   новые fx-дорожки «FX: <имя пресета>» поверх всех.
 */
export function planPresetDrop(
  p: Project,
  preset: Pick<EffectPreset, 'name' | 'effects'>,
  target: EffectDropTarget,
  t: number,
): EditOp[] {
  if (preset.effects.length === 0) throw new OpsError('bad_value', 'Пресет пустой')
  const frame = 1 / p.fps
  const at = Math.max(0, t)
  const effects = [...preset.effects].sort((a, b) => a.start - b.start)

  if (typeof target === 'object' && 'clipId' in target) {
    const ref = findClip(p, target.clipId)
    if (!ref) throw new OpsError('clip_not_found', `Клип ${target.clipId} не найден`)
    if (ref.track.kind !== 'video') throw new OpsError('incompatible_track', 'Эффекты кладутся на видеоклипы')
    const c = ref.clip
    const ops: EditOp[] = []
    const base = Math.min(Math.max(at - c.start, 0), Math.max(0, c.duration - frame))
    for (const e of effects) {
      const start = base + e.start
      if (start > c.duration - frame + EPS) continue
      ops.push({
        op: 'addEffect',
        target: { clipId: c.id },
        effect: effectInput(e, start, Math.min(e.duration, c.duration - start)),
      })
    }
    if (ops.length === 0) throw new OpsError('slots_overlap', 'Пресет не помещается в клип')
    return ops
  }

  let first: Track | null = null
  if (target !== 'newFxTrack') {
    first = findTrack(p, target.trackId) ?? null
    if (!first) throw new OpsError('track_not_found', `Дорожка ${target.trackId} не найдена`)
    if (first.kind !== 'fx')
      throw new OpsError('incompatible_track', 'Эффект можно положить только на fx-дорожку')
  }
  // слои: занятые интервалы; слой 0 — выбранная дорожка с её элементами
  const lanes: { trackId: string; busy: { start: number; end: number }[] }[] = []
  if (first)
    lanes.push({ trackId: first.id, busy: first.items.map((i) => ({ start: i.start, end: itemEnd(i) })) })
  const ops: EditOp[] = []
  for (const e of effects) {
    const span = { start: at + e.start, end: at + e.start + e.duration }
    let lane = lanes.find((l) => l.busy.every((b) => !overlaps(b, span)))
    if (!lane) {
      const id = `tmp_preset${lanes.length + 1}`
      ops.push({ op: 'addTrack', track: { ...trackInput(p, 'fx', id), name: `FX: ${preset.name}` } })
      lane = { trackId: id, busy: [] }
      lanes.push(lane)
    }
    lane.busy.push(span)
    ops.push({
      op: 'addEffect',
      target: { trackId: lane.trackId },
      effect: effectInput(e, span.start, e.duration),
    })
  }
  return ops
}

/** Есть ли в выделении что сохранить пресетом (для доступности кнопки). */
export function selectionHasEffects(
  p: Project,
  selection: readonly string[],
  inspectedEffectId?: string | null,
) {
  for (const id of selection) {
    const ref = findItem(p, id)
    if (ref && (isEffect(ref.item) || (isClip(ref.item) && ref.item.effects.length > 0))) return true
  }
  return !!inspectedEffectId && !!findEffect(p, inspectedEffectId)
}
