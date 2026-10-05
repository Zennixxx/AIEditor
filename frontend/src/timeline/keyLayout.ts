// Ключевые кадры на дорожках свойств в экранных координатах + хит-тест. Без React и Canvas.
import { itemEnd } from '@/model/clipTime'
import { laneKeyEase, laneKeyTimes, sameKey, type KeyRef } from '@/model/clipKeys'
import { isClip } from '@/model/lookup'
import type { Clip, Ease } from '@/shared/types.gen'
import { LANE_H, laneScreenTop, RULER_H, timeToX, xToTime, type TrackRow, type View } from './geometry'

export interface KeyView {
  ref: KeyRef
  clip: Clip
  x: number
  y: number
  ease: Ease
  selected: boolean
}

/** Радиус попадания по ромбику, px. */
export const KEY_HIT_PX = 6

export function layoutKeys(rows: readonly TrackRow[], v: View, selection: readonly KeyRef[]): KeyView[] {
  const res: KeyView[] = []
  const t0 = xToTime(-KEY_HIT_PX, v)
  const t1 = xToTime(v.width + KEY_HIT_PX, v)
  for (const row of rows) {
    if (row.lanes.length === 0) continue
    for (const item of row.track.items) {
      if (!isClip(item) || itemEnd(item) < t0 || item.start > t1) continue
      for (const lane of row.lanes) {
        const top = laneScreenTop(row, lane, v)!
        if (top + LANE_H < RULER_H || top > v.height) continue
        for (const t of laneKeyTimes(item, lane)) {
          const ref = { clipId: item.id, lane, t }
          res.push({
            ref,
            clip: item,
            x: timeToX(item.start + t, v),
            y: top + LANE_H / 2,
            ease: laneKeyEase(item, lane, t) ?? 'linear',
            selected: selection.some((s) => sameKey(s, ref)),
          })
        }
      }
    }
  }
  return res
}

/** Ключ под точкой (ближайший по x в пределах KEY_HIT_PX) или null. */
export function hitKey(keys: readonly KeyView[], x: number, y: number): KeyView | null {
  let best: KeyView | null = null
  for (const k of keys) {
    if (Math.abs(k.y - y) > LANE_H / 2 || Math.abs(k.x - x) > KEY_HIT_PX) continue
    if (!best || Math.abs(k.x - x) < Math.abs(best.x - x)) best = k
  }
  return best
}
