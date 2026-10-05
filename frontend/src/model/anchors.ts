// Привязка эффектов к маркерам (CONTRACT §2: `anchor` — start = время маркера + offset; при перемещении
// маркера эффект едет следом). Выполняется в конце каждой транзакции applyOps.
import type { Clip, EffectItem, Marker, Project } from '@/shared/types.gen'
import { EPS, timelineAtSource } from './clipTime'
import { isClip } from './lookup'

/**
 * Синхронизирует эффекты с маркерами:
 * - эффект, изменённый/созданный в этой транзакции (`touched`), сохраняет своё место — пересчитывается `offset`;
 * - остальные привязанные эффекты ставятся в `время маркера + offset` (маркер или его клип сдвинулись).
 * Маркер вне видимого диапазона клипа (или удалён) — эффект не трогается.
 * Сдвинутый эффект fx-дорожки, наехавший на следующий элемент, укорачивается до него (как в
 * applyEffectToMarkers); если места нет совсем — инвариант 1 отклонит транзакцию.
 */
export function syncAnchors(p: Project, touched: ReadonlySet<string>): void {
  const markers = new Map<string, { marker: Marker; clip: Clip | null }>()
  for (const m of p.markers) markers.set(m.id, { marker: m, clip: null })
  for (const t of p.tracks) {
    for (const item of t.items) {
      if (isClip(item)) for (const m of item.markers) markers.set(m.id, { marker: m, clip: item })
    }
  }

  const moved = new Set<string>()
  const sync = (e: EffectItem, owner: Clip | null) => {
    const a = e.anchor
    if (!a) return
    const ref = markers.get(a.markerId)
    if (!ref) return
    const t = ref.clip ? timelineAtSource(ref.clip, ref.marker.t) : ref.marker.t
    if (t === null) return
    const base = owner ? t - owner.start : t
    if (touched.has(e.id)) {
      const offset = e.start - base
      if (Math.abs(offset - a.offset) > EPS) a.offset = Math.abs(offset) < EPS ? 0 : offset
    } else {
      const start = base + a.offset
      if (Math.abs(start - e.start) > EPS) {
        e.start = start
        moved.add(e.id)
      }
    }
  }

  for (const t of p.tracks) {
    for (const item of t.items) {
      if (isClip(item)) for (const e of item.effects) sync(e, item)
      else sync(item, null)
    }
  }

  if (moved.size === 0) return
  for (const t of p.tracks) {
    if (t.kind !== 'fx') continue
    t.items.sort((a, b) => a.start - b.start)
    for (let i = 0; i + 1 < t.items.length; i++) {
      const a = t.items[i]!
      const b = t.items[i + 1]!
      if (!moved.has(a.id) && !moved.has(b.id)) continue
      const gap = b.start - a.start
      if (a.start + a.duration > b.start + EPS && gap > EPS) a.duration = gap
    }
  }
}
