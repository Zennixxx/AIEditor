// Макро-op `applyEffectToMarkers` (CONTRACT §6.2): эффект на каждый отфильтрованный маркер.
// Чистые функции: проект не меняют, возвращают примитивные ops (addTrack + addEffect), которые
// applyOps выполняет в той же транзакции.
import type { EditOp, EffectAnchor, EffectInput, Envelope, Project } from '@/shared/types.gen'
import { getEffectDef, paramErrors } from '@/shared/effects-registry'
import { EPS, itemEnd } from './clipTime'
import { findTrack, isClip } from './lookup'
import { filterMarkers } from './markerFilter'
import type { TimelineMarker } from './markers'
import { OpsError } from './ops/errors'

export type ApplyFxOp = Extract<EditOp, { op: 'applyEffectToMarkers' }>

/** Маркеры фильтра без «дублей» ближе кадра к предыдущему оставленному (как в cutToMarkers). */
export function effectMarkers(p: Project, op: Pick<ApplyFxOp, 'filter'>): TimelineMarker[] {
  const minGap = 1 / p.fps
  const kept: TimelineMarker[] = []
  for (const m of filterMarkers(p, op.filter)) {
    const last = kept[kept.length - 1]
    if (!last || m.t - last.t >= minGap - EPS) kept.push(m)
  }
  return kept
}

let tmpCounter = 0

export function expandApplyEffectToMarkers(p: Project, op: ApplyFxOp): EditOp[] {
  const def = getEffectDef(op.effect)
  if (!def) throw new OpsError('unknown_effect', `Неизвестный эффект ${op.effect}`)
  const params = { ...(op.params ?? {}) }
  const errors = paramErrors(op.effect, params)
  if (errors.length > 0) throw new OpsError('bad_value', errors[0]!, { details: errors })
  const duration = op.duration ?? def.defaultDuration
  if (!(Number.isFinite(duration) && duration > 0))
    throw new OpsError('bad_value', 'duration должна быть > 0')
  const envelope: Envelope = { ...def.defaultEnvelope }
  for (const [k, v] of Object.entries(op.envelope ?? {})) {
    if (v !== undefined) (envelope as unknown as Record<string, unknown>)[k] = v
  }
  for (const k of ['attack', 'hold', 'decay'] as const) {
    if (!(Number.isFinite(envelope[k]) && envelope[k] >= 0))
      throw new OpsError('bad_value', `envelope.${k} < 0`)
  }
  if (!['linear', 'exp', 'easeOut'].includes(envelope.curve))
    throw new OpsError('bad_value', `envelope.curve: ${String(envelope.curve)}`)

  const markers = effectMarkers(p, op)
  if (markers.length === 0) throw new OpsError('no_markers', 'Фильтр не оставил ни одного маркера')

  const strengthDef = def.params.find((x) => x.key === 'strength' && x.type === 'number')
  const effectFor = (m: TimelineMarker, start: number, d: number): EffectInput => {
    const fxParams = { ...params }
    if (op.scaleByStrength && strengthDef) {
      const base = typeof params.strength === 'number' ? params.strength : (strengthDef.default as number)
      const v = base * m.marker.strength
      fxParams.strength = Math.min(Math.max(v, strengthDef.min ?? -Infinity), strengthDef.max ?? Infinity)
    }
    const anchor: EffectAnchor = { markerId: m.marker.id, offset: 0 }
    if (m.clipId !== null) anchor.clipId = m.clipId
    return {
      effect: op.effect,
      start,
      duration: d,
      params: fxParams,
      envelope: { ...envelope },
      anchor,
      enabled: true,
    }
  }
  /** Длительность на маркере i: до следующего маркера, чтобы эффекты одного вызова не перекрывались. */
  const durAt = (i: number): number => {
    const next = markers[i + 1]
    return next ? Math.min(duration, next.t - markers[i]!.t) : duration
  }

  const ops: EditOp[] = []
  if (op.target === 'clipsUnderMarker') {
    markers.forEach((m, i) => {
      for (const track of p.tracks) {
        if (track.kind !== 'video') continue
        for (const clip of track.items) {
          if (!isClip(clip)) continue
          if (!(m.t >= clip.start - EPS && m.t < itemEnd(clip) - EPS)) continue
          const start = Math.max(0, m.t - clip.start)
          const d = Math.min(durAt(i), clip.duration - start)
          if (d > EPS)
            ops.push({ op: 'addEffect', target: { clipId: clip.id }, effect: effectFor(m, start, d) })
        }
      }
    })
    if (ops.length === 0) throw new OpsError('no_markers', 'Под отфильтрованными маркерами нет видеоклипов')
    return ops
  }

  let trackId: string
  if (op.target === 'newFxTrack') {
    trackId = `tmp_aetm${++tmpCounter}`
    ops.push({
      op: 'addTrack',
      track: { id: trackId, kind: 'fx', name: `FX: ${def.name}`, muted: false, locked: false, hidden: false },
    })
  } else {
    trackId = op.target.trackId
    const track = findTrack(p, trackId)
    if (!track) throw new OpsError('track_not_found', `Дорожка ${trackId} не найдена`)
    if (track.kind !== 'fx')
      throw new OpsError('incompatible_track', 'Эффекты по маркерам кладутся на fx-дорожку')
    trackId = track.id
    markers.forEach((m, i) => {
      const end = m.t + durAt(i)
      const hit = track.items.find((it) => it.start < end - EPS && itemEnd(it) > m.t + EPS)
      if (hit)
        throw new OpsError('slots_overlap', `На дорожке ${track.name} уже есть эффект в ${m.t.toFixed(3)} с`)
    })
  }
  markers.forEach((m, i) => {
    ops.push({ op: 'addEffect', target: { trackId }, effect: effectFor(m, m.t, durAt(i)) })
  })
  return ops
}
