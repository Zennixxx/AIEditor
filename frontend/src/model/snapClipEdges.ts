// Макро-op `snapClipEdgesToMarkers` (CONTRACT §6.2): края клипов подтягиваются к ближайшим маркерам.
// Чистые функции: проект не меняют, возвращают примитивные ops (updateClip).
import type { EditOp, Project } from '@/shared/types.gen'
import { itemEnd } from './clipTime'
import { findClip, isClip } from './lookup'
import { filterMarkers } from './markerFilter'
import { OpsError } from './ops/errors'
import { planTrim } from './edit'

export type SnapEdgesOp = Extract<EditOp, { op: 'snapClipEdgesToMarkers' }>

/** Ближайшая к `t` точка из отсортированного списка в пределах `maxShift`, иначе null. */
export function nearestWithin(sorted: readonly number[], t: number, maxShift: number): number | null {
  let best: number | null = null
  let bestDist = Infinity
  for (const m of sorted) {
    const d = Math.abs(m - t)
    if (d < bestDist - 1e-12) {
      best = m
      bestDist = d
    }
  }
  return best !== null && bestDist <= maxShift + 1e-9 ? best : null
}

/**
 * Раскрывает `snapClipEdgesToMarkers`: у каждого клипа начало и конец сдвигаются (трим) к ближайшему
 * маркеру по `filter`, если он не дальше `maxShift` сек. Трим ограничен соседями по дорожке, исходником и
 * минимальной длительностью в 1 кадр (как ручной трим, `planTrim`), поэтому результат всегда валиден.
 * Клипы обрабатываются слева направо на рабочей копии: сдвиг одного учитывается при расчёте следующего.
 * Стык двух выбранных впритык лежащих клипов сдвигается вместе (roll): оба края идут к одному маркеру.
 */
export function expandSnapClipEdges(p: Project, op: SnapEdgesOp): EditOp[] {
  if (!(op.maxShift >= 0) || !Number.isFinite(op.maxShift))
    throw new OpsError('bad_value', 'maxShift должен быть конечным числом ≥ 0')
  const ids = [...new Set(op.clipIds)]
  for (const id of ids) if (!findClip(p, id)) throw new OpsError('clip_not_found', `Клип ${id} не найден`)
  const markers = filterMarkers(p, op.filter).map((m) => m.t)
  if (markers.length === 0 || ids.length === 0) return []

  const work = structuredClone(p)
  const ordered = ids.map((id) => findClip(work, id)!).sort((a, b) => a.clip.start - b.clip.start)
  const selected = new Set(ids)
  const get = (id: string) => findClip(work, id)!.clip
  const trim = (id: string, edge: 'start' | 'end', t: number) => {
    const op = planTrim(work, id, edge, t)
    if (op?.op === 'updateClip') Object.assign(get(id), op.patch)
  }
  /** Клип, начало которого лежит впритык к концу `id` на той же дорожке (если он тоже выбран). */
  const touching = (id: string): string | null => {
    const ref = findClip(work, id)!
    const next = ref.track.items[ref.index + 1]
    return next && isClip(next) && selected.has(next.id) && Math.abs(next.start - itemEnd(ref.clip)) < 1e-9
      ? next.id
      : null
  }

  const before = new Map(ordered.map(({ clip }) => [clip.id, { ...clip }]))
  const joined = new Set<string>() // клипы, чьё начало уже сдвинуто вместе с концом предыдущего
  for (const { clip } of ordered) {
    const id = clip.id
    if (!joined.has(id)) {
      const at = get(id).start
      const target = nearestWithin(markers, at, op.maxShift)
      if (target !== null && Math.abs(target - at) >= 1e-9) trim(id, 'start', target)
    }
    const end = itemEnd(get(id))
    const target = nearestWithin(markers, end, op.maxShift)
    if (target === null || Math.abs(target - end) < 1e-9) continue
    const next = touching(id)
    if (next === null) {
      trim(id, 'end', target)
    } else {
      joined.add(next)
      // освобождаем место: при сдвиге вправо сначала подтягивается начало соседа, при сдвиге влево — конец клипа
      if (target > end) {
        trim(next, 'start', target)
        trim(id, 'end', target)
      } else {
        trim(id, 'end', target)
        trim(next, 'start', target)
      }
    }
  }

  const ops: EditOp[] = []
  for (const { clip } of ordered) {
    const after = get(clip.id)
    const was = before.get(clip.id)!
    const patch = {
      start: after.start,
      duration: after.duration,
      sourceIn: after.sourceIn,
      sourceOut: after.sourceOut,
    }
    const changed = (Object.keys(patch) as (keyof typeof patch)[]).some(
      (k) => Math.abs(patch[k] - was[k]) > 1e-9,
    )
    if (changed) ops.push({ op: 'updateClip', clipId: clip.id, patch })
  }
  return ops
}
