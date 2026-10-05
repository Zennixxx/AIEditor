// Ключевые кадры transform/opacity на уровне клипов и дорожек свойств таймлайна (FRONTEND.md §4.2).
// Время ключа — от начала клипа (CONTRACT §2). Чистые функции: проект не меняют, возвращают ops.
import type { Animatable, Clip, ClipPatch, EditOp, Ease, Project } from '@/shared/types.gen'
import { findClip } from './lookup'
import {
  ANIM_PROPS,
  clipAnimatable,
  isAnimated,
  KEY_EPS,
  keyAt,
  LANE_FIELDS,
  LANE_PROPS,
  removeKey,
  setKeyEase,
  shiftKeys,
  type AnimProp,
  type LaneProp,
} from './keyframes'

/** Ключ на дорожке свойства: клип, дорожка (позиция = x и y), время от начала клипа. */
export interface KeyRef {
  clipId: string
  lane: LaneProp
  t: number
}

export function sameKey(a: KeyRef, b: KeyRef): boolean {
  return a.clipId === b.clipId && a.lane === b.lane && Math.abs(a.t - b.t) <= KEY_EPS
}

function uniqueTimes(times: number[]): number[] {
  const res: number[] = []
  for (const t of times.sort((a, b) => a - b)) {
    if (res.length === 0 || t - res[res.length - 1]! > KEY_EPS) res.push(t)
  }
  return res
}

/** Времена ключей дорожки свойства (объединение по её полям). */
export function laneKeyTimes(clip: Pick<Clip, 'transform' | 'opacity'>, lane: LaneProp): number[] {
  return uniqueTimes(
    LANE_FIELDS[lane].flatMap((f) => {
      const a = clipAnimatable(clip, f)
      return isAnimated(a) ? a.map((k) => k.t) : []
    }),
  )
}

/** Ease ключа дорожки во время `t` (по первому полю, у которого есть ключ). */
export function laneKeyEase(
  clip: Pick<Clip, 'transform' | 'opacity'>,
  lane: LaneProp,
  t: number,
): Ease | null {
  for (const f of LANE_FIELDS[lane]) {
    const k = keyAt(clipAnimatable(clip, f), t)
    if (k) return k.ease
  }
  return null
}

/** Все времена ключей клипа (для ромбиков на клипе). */
export function clipKeyTimes(clip: Pick<Clip, 'transform' | 'opacity'>): number[] {
  return uniqueTimes(LANE_PROPS.flatMap((l) => laneKeyTimes(clip, l)))
}

export function laneIsAnimated(clip: Pick<Clip, 'transform' | 'opacity'>, lane: LaneProp): boolean {
  return LANE_FIELDS[lane].some((f) => isAnimated(clipAnimatable(clip, f)))
}

/** Патч updateClip из изменённых свойств (transform — целиком, как требует updateClip). */
export function patchFromProps(
  clip: Pick<Clip, 'transform'>,
  values: Partial<Record<AnimProp, Animatable>>,
): ClipPatch {
  const patch: ClipPatch = {}
  const tr = { ...clip.transform }
  let touched = false
  for (const prop of ANIM_PROPS) {
    const v = values[prop]
    if (v === undefined) continue
    if (prop === 'opacity') patch.opacity = v
    else {
      tr[prop] = v
      touched = true
    }
  }
  if (touched) patch.transform = tr
  return patch
}

/** Применить `fn` к полям дорожек ключей `refs`, сгруппированных по клипам → ops updateClip. */
function planByClip(
  p: Project,
  refs: readonly KeyRef[],
  fn: (value: Animatable, times: number[], clip: Clip) => Animatable,
): EditOp[] {
  const byClip = new Map<string, Map<LaneProp, number[]>>()
  for (const r of refs) {
    const lanes = byClip.get(r.clipId) ?? new Map<LaneProp, number[]>()
    lanes.set(r.lane, [...(lanes.get(r.lane) ?? []), r.t])
    byClip.set(r.clipId, lanes)
  }
  const ops: EditOp[] = []
  for (const [clipId, lanes] of byClip) {
    const clip = findClip(p, clipId)?.clip
    if (!clip) continue
    const values: Partial<Record<AnimProp, Animatable>> = {}
    for (const [lane, times] of lanes) {
      for (const f of LANE_FIELDS[lane]) {
        const before = clipAnimatable(clip, f)
        const after = fn(before, times, clip)
        if (after !== before) values[f] = after
      }
    }
    if (Object.keys(values).length > 0)
      ops.push({ op: 'updateClip', clipId, patch: patchFromProps(clip, values) })
  }
  return ops
}

export function planRemoveKeys(p: Project, refs: readonly KeyRef[]): EditOp[] {
  return planByClip(p, refs, (value, times) => times.reduce<Animatable>((v, t) => removeKey(v, t), value))
}

export function planKeysEase(p: Project, refs: readonly KeyRef[], ease: Ease): EditOp[] {
  return planByClip(p, refs, (value, times) =>
    times.reduce<Animatable>((v, t) => setKeyEase(v, t, ease), value),
  )
}

/** Сдвиг ключей на `delta` сек (каждый — в пределах своего клипа). */
export function planShiftKeys(p: Project, refs: readonly KeyRef[], delta: number): EditOp[] {
  if (Math.abs(delta) <= KEY_EPS / 10) return []
  return planByClip(p, refs, (value, times, clip) => shiftKeys(value, times, delta, clip.duration))
}

/** Ключи после сдвига: те же ссылки с новым временем (для выделения после drag). */
export function shiftedRefs(p: Project, refs: readonly KeyRef[], delta: number): KeyRef[] {
  return refs.map((r) => {
    const d = findClip(p, r.clipId)?.clip.duration ?? Infinity
    return { ...r, t: Math.min(Math.max(r.t + delta, 0), d) }
  })
}
