// Переходы на стыках клипов (FRONTEND.md §4.2): эффект категории `transition` ставится на fx-дорожку
// прямо над видеодорожкой стыка, центром на стыке. fx-дорожка — adjustment layer (CONTRACT §2 п. 7),
// поэтому переход видит композит «A до стыка, B после» и работает с одним кадром.
// Чистые функции: проект не меняют, возвращают ops.
import type { EditOp, Project, Track } from '@/shared/types.gen'
import { getEffectDef } from '@/shared/effects-registry'
import { EPS, itemEnd } from './clipTime'
import { isClip, isEffect } from './lookup'
import { newEffectInput } from './effects'
import { OpsError } from './ops/errors'
import { trackInput } from './project'

export interface Cut {
  /** Timeline time стыка. */
  t: number
  trackId: string
  leftId: string
  rightId: string
  /** Длительности соседних клипов — переход не заходит дальше середины каждого. */
  leftDuration: number
  rightDuration: number
}

export function isTransition(effectId: string): boolean {
  return getEffectDef(effectId)?.category === 'transition'
}

/**
 * Стыки на видеодорожках: соседние клипы встык (зазор не больше полукадра). `clipIds` — только стыки,
 * у которых выделен хотя бы один из двух клипов. Результат — по дорожкам, внутри — по времени.
 */
export function findCuts(p: Project, clipIds?: ReadonlySet<string>): Cut[] {
  const gap = 0.5 / p.fps + EPS
  const cuts: Cut[] = []
  for (const track of p.tracks) {
    if (track.kind !== 'video') continue
    const clips = track.items.filter(isClip)
    for (let i = 0; i + 1 < clips.length; i++) {
      const a = clips[i]!
      const b = clips[i + 1]!
      if (Math.abs(b.start - itemEnd(a)) > gap) continue
      if (clipIds && !clipIds.has(a.id) && !clipIds.has(b.id)) continue
      cuts.push({
        t: b.start,
        trackId: track.id,
        leftId: a.id,
        rightId: b.id,
        leftDuration: a.duration,
        rightDuration: b.duration,
      })
    }
  }
  return cuts
}

/** Ближайший к `t` стык не дальше `maxDist`; на дорожке `trackId` (если на ней есть стыки), иначе на любой. */
export function nearestCut(p: Project, t: number, maxDist: number, trackId?: string): Cut | null {
  const all = findCuts(p)
  const own = trackId ? all.filter((c) => c.trackId === trackId) : []
  let best: Cut | null = null
  for (const c of own.length > 0 ? own : all) {
    if (Math.abs(c.t - t) <= maxDist && (!best || Math.abs(c.t - t) < Math.abs(best.t - t))) best = c
  }
  return best
}

/** Интервал перехода на стыке: длительность не больше `duration` и не больше каждого из соседних клипов. */
export function transitionSpan(cut: Cut, duration: number): { start: number; duration: number } {
  const d = Math.min(duration, cut.leftDuration, cut.rightDuration)
  return { start: Math.max(0, cut.t - d / 2), duration: d }
}

function isFree(track: Track, spans: readonly { start: number; duration: number }[]): boolean {
  return spans.every((s) =>
    track.items.every((it) => it.start >= s.start + s.duration - EPS || itemEnd(it) <= s.start + EPS),
  )
}

export interface TransitionPlan {
  ops: EditOp[]
  /** Куда легли переходы: существующая fx-дорожка или null (новая над видеодорожкой). */
  targets: { videoTrackId: string; fxTrackId: string | null; spans: { start: number; duration: number }[] }[]
}

/**
 * Переход `effectId` на каждый стык из `cuts`. Дорожка — первая fx-дорожка непосредственно над видеодорожкой
 * стыка (до следующей видеодорожки), на которой только переходы и есть место под все интервалы; иначе —
 * новая fx-дорожка «Переходы» сразу над видеодорожкой.
 */
export function planTransitions(
  p: Project,
  effectId: string,
  cuts: readonly Cut[],
  duration?: number,
): TransitionPlan {
  const def = getEffectDef(effectId)
  if (!def) throw new OpsError('unknown_effect', `Неизвестный эффект ${effectId}`)
  if (def.category !== 'transition') throw new OpsError('bad_value', `${def.name} — не переход`)
  if (cuts.length === 0) throw new OpsError('no_cuts', 'Нет стыков клипов')
  const d = duration ?? def.defaultDuration
  const frame = 1 / p.fps
  const ops: EditOp[] = []
  const targets: TransitionPlan['targets'] = []
  let tmp = 0

  const byTrack = new Map<string, Cut[]>()
  for (const c of cuts) byTrack.set(c.trackId, [...(byTrack.get(c.trackId) ?? []), c])

  const groups = [...byTrack].map(([videoTrackId, list]) => {
    const vi = p.tracks.findIndex((t) => t.id === videoTrackId)
    if (vi < 0 || p.tracks[vi]!.kind !== 'video')
      throw new OpsError('incompatible_track', 'Стык должен быть на видеодорожке')
    return { videoTrackId, list, vi }
  })
  // сверху вниз: новая дорожка над верхней видеодорожкой не сдвигает индексы нижних
  groups.sort((a, b) => b.vi - a.vi)

  for (const { videoTrackId, list, vi } of groups) {
    const spans = [...list]
      .sort((a, b) => a.t - b.t)
      .map((c) => transitionSpan(c, d))
      .filter((s) => s.duration >= frame - EPS)
    if (spans.length === 0) continue

    let fxTrackId: string | null = null
    for (let i = vi + 1; i < p.tracks.length && p.tracks[i]!.kind === 'fx'; i++) {
      const t = p.tracks[i]!
      const onlyTransitions = t.items.every((it) => isEffect(it) && isTransition(it.effect))
      if (onlyTransitions && isFree(t, spans)) {
        fxTrackId = t.id
        break
      }
    }
    let target = fxTrackId
    if (!target) {
      target = `tmp_transitions${++tmp}`
      ops.push({
        op: 'addTrack',
        track: { ...trackInput(p, 'fx', target), name: 'Переходы' },
        index: vi + 1,
      })
    }
    for (const s of spans)
      ops.push({
        op: 'addEffect',
        target: { trackId: target },
        effect: newEffectInput(effectId, s.start, s.duration),
      })
    targets.push({ videoTrackId, fxTrackId, spans })
  }
  if (targets.length === 0) throw new OpsError('no_cuts', 'Соседние клипы слишком короткие для перехода')
  return { ops, targets }
}
