// Ripple: сомкнуть пробелы на дорожке. Чистая функция: проект не меняет, строит ops.
import type { EditOp, Project } from '@/shared/types.gen'
import { EPS, itemEnd } from './clipTime'
import { isClip } from './lookup'

/**
 * Сдвигает элементы дорожки влево так, чтобы между соседними не оставалось пробелов. Первый элемент
 * остаётся на месте (пробел в начале сохраняется: он нужен для синхронизации с музыкой).
 * Пустой список — пробелов нет, дорожка не найдена или заблокирована.
 */
export function planRippleTrack(p: Project, trackId: string): EditOp[] {
  const track = p.tracks.find((t) => t.id === trackId)
  if (!track || track.locked) return []
  const items = [...track.items].sort((a, b) => a.start - b.start)
  const ops: EditOp[] = []
  let end = items[0] ? itemEnd(items[0]) : 0
  for (const item of items.slice(1)) {
    if (item.start > end + EPS) {
      ops.push(
        isClip(item)
          ? { op: 'moveClip', clipId: item.id, start: end }
          : { op: 'updateEffect', effectId: item.id, patch: { start: end } },
      )
      end += item.duration
    } else {
      end = Math.max(end, itemEnd(item))
    }
  }
  return ops
}

/** Есть ли на дорожке пробелы между элементами (для состояния кнопки). */
export function hasGaps(p: Project, trackId: string): boolean {
  return planRippleTrack(p, trackId).length > 0
}
