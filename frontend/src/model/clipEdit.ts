// Чистые преобразования клипа: разрезание и трим (с учётом reverse и timeRemap).
import type { Animatable, Asset, Clip, Transform } from '@/shared/types.gen'
import { EPS, edgeSpeed, effectiveSourceOut, forwardSource } from './clipTime'
import { splitAnimatable } from './keyframes'
import { restrictKeyframes } from './timeRemap'

function splitTransform(t: Transform, at: number): [Transform, Transform] {
  const [x0, x1] = splitAnimatable(t.x, at)
  const [y0, y1] = splitAnimatable(t.y, at)
  const [s0, s1] = splitAnimatable(t.scale, at)
  const [r0, r1] = splitAnimatable(t.rotation, at)
  return [
    { ...t, x: x0, y: y0, scale: s0, rotation: r0 },
    { ...t, x: x1, y: y1, scale: s1, rotation: r1 },
  ]
}

/**
 * Делит клип в точке `tau` (сек от начала клипа). Возвращает две половины; правая получает `rightId`.
 * Source-диапазоны стыкуются точно: левая половина заканчивается на том кадре исходника, с которого начинается правая.
 * У клипа с timeRemap половины получают fit="stretch" (точные диапазоны) и ключи, обрезанные по u.
 * Маркеры клипа (source time) уходят в ту половину, чей диапазон их содержит; эффекты клипа — по своему start.
 * Секции клипа (source time, CONTRACT §6.1 п. 10) получает каждая половина, с чьим диапазоном они пересекаются, без обрезки;
 * попавшая в обе остаётся с исходным ID слева, справа — новый (`newSectionId`).
 */
export function splitClipData(
  clip: Clip,
  tau: number,
  rightId: string,
  newSectionId: () => string = () => {
    throw new Error('newSectionId не задан')
  },
): { left: Clip; right: Clip } {
  const D = clip.duration
  const outEff = effectiveSourceOut(clip)
  const consumed = forwardSource(clip, tau) - clip.sourceIn
  const cut = clip.reverse ? outEff - consumed : clip.sourceIn + consumed

  const leftRange: [number, number] = clip.reverse ? [cut, outEff] : [clip.sourceIn, cut]
  const rightRange: [number, number] = clip.reverse ? [clip.sourceIn, cut] : [cut, outEff]

  const [tl, tr] = splitTransform(clip.transform, tau)
  const [ol, or] = splitAnimatable(clip.opacity, tau)
  const vol: [Animatable, Animatable] | null =
    clip.volume !== undefined ? splitAnimatable(clip.volume, tau) : null

  const inRight = (t: number) => t >= rightRange[0] - EPS && t <= rightRange[1] + EPS
  const rightMarkers = clip.markers.filter(
    (m) => inRight(m.t) && !(clip.reverse && Math.abs(m.t - cut) < EPS),
  )
  const leftMarkers = clip.markers.filter((m) => !rightMarkers.includes(m))

  const base = { ...clip }
  delete base.timeRemap
  delete base.volume
  const left: Clip = {
    ...base,
    duration: tau,
    sourceIn: leftRange[0],
    sourceOut: leftRange[1],
    transform: tl,
    opacity: ol,
    effects: clip.effects.filter((e) => e.start < tau - EPS),
    markers: leftMarkers,
  }
  const right: Clip = {
    ...base,
    id: rightId,
    start: clip.start + tau,
    duration: D - tau,
    sourceIn: rightRange[0],
    sourceOut: rightRange[1],
    transform: tr,
    opacity: or,
    effects: clip.effects.filter((e) => e.start >= tau - EPS).map((e) => ({ ...e, start: e.start - tau })),
    markers: rightMarkers,
  }
  if (clip.sections) {
    const hits = (s: { start: number; end: number }, r: [number, number]) =>
      s.start < r[1] - EPS && s.end > r[0] + EPS
    left.sections = clip.sections.filter((s) => hits(s, leftRange))
    right.sections = clip.sections
      .filter((s) => hits(s, rightRange))
      .map((s) => (hits(s, leftRange) ? { ...s, id: newSectionId() } : s))
  }
  if (vol) {
    left.volume = vol[0]
    right.volume = vol[1]
  }
  if (clip.timeRemap) {
    const u = tau / D
    left.timeRemap = {
      ...clip.timeRemap,
      fit: 'stretch',
      keyframes: restrictKeyframes(clip.timeRemap.keyframes, 0, u),
    }
    right.timeRemap = {
      ...clip.timeRemap,
      fit: 'stretch',
      keyframes: restrictKeyframes(clip.timeRemap.keyframes, u, 1),
    }
  }
  return { left, right }
}

export type TrimEdge = 'start' | 'end'

export interface TrimLimits {
  /** Нижняя граница timeline-позиции края (конец предыдущего элемента / 0). */
  min: number
  /** Верхняя граница (начало следующего элемента / ∞). */
  max: number
  /** Минимальная длительность клипа (обычно 1 кадр). */
  minDuration: number
  /** Если задан — границы, вычисленные из исходника, округляются внутрь до сетки кадров. */
  fps?: number
}

export type ClipTrimPatch = Pick<Clip, 'start' | 'duration' | 'sourceIn' | 'sourceOut'>

/**
 * Трим края клипа: новая timeline-позиция края `edgeTime` ограничивается соседями, минимальной длительностью
 * и доступным диапазоном исходника (0..asset.duration). Возвращает новые start/duration/sourceIn/sourceOut.
 */
export function trimClipData(
  clip: Clip,
  asset: Asset | undefined,
  edge: TrimEdge,
  edgeTime: number,
  limits: TrimLimits,
): ClipTrimPatch {
  const D = clip.duration
  const end = clip.start + D
  const outEff = effectiveSourceOut(clip)
  const assetMax = asset && asset.kind !== 'image' ? asset.duration : Infinity

  if (edge === 'start') {
    // сколько исходника доступно «до» начала клипа на таймлайне
    const room = clip.reverse ? assetMax - outEff : clip.sourceIn
    const v = edgeSpeed(clip, 0)
    const minStart = Math.max(limits.min, frameCeil(clip.start - room / v, limits.fps))
    const t = Math.min(Math.max(edgeTime, minStart), end - limits.minDuration)
    const d = t - clip.start // > 0 — укорачиваем
    // объём исходника, убранный (>0) или добавленный (<0) с начала клипа на таймлайне
    const removed = d >= 0 ? forwardSource(clip, d) - clip.sourceIn : d * v
    const patch: ClipTrimPatch = { start: t, duration: end - t, sourceIn: clip.sourceIn, sourceOut: outEff }
    if (clip.reverse) patch.sourceOut = clamp(outEff - removed, 0, assetMax)
    else patch.sourceIn = clamp(clip.sourceIn + removed, 0, assetMax)
    return fixDuration(clip, patch, clip.reverse ? 'out' : 'in')
  }

  const room = clip.reverse ? clip.sourceIn : assetMax - outEff
  const v = edgeSpeed(clip, 1)
  const maxEnd = Math.min(limits.max, frameFloor(end + room / v, limits.fps))
  const t = Math.max(Math.min(edgeTime, maxEnd), clip.start + limits.minDuration)
  const e = t - end // < 0 — укорачиваем
  // объём исходника, убранный (>0) или добавленный (<0) с конца клипа на таймлайне
  const removed = e <= 0 ? outEff - forwardSource(clip, D + e) : -e * v
  const patch: ClipTrimPatch = {
    start: clip.start,
    duration: t - clip.start,
    sourceIn: clip.sourceIn,
    sourceOut: outEff,
  }
  if (clip.reverse) patch.sourceIn = clamp(clip.sourceIn + removed, 0, assetMax)
  else patch.sourceOut = clamp(outEff - removed, 0, assetMax)
  return fixDuration(clip, patch, clip.reverse ? 'in' : 'out')
}

/** Без timeRemap держим инвариант 4 точно: duration = (sourceOut − sourceIn) / speed (правится изменённая сторона). */
function fixDuration(clip: Clip, patch: ClipTrimPatch, side: 'in' | 'out'): ClipTrimPatch {
  if (clip.timeRemap) return patch
  if (side === 'out') patch.sourceOut = patch.sourceIn + patch.duration * clip.speed
  else patch.sourceIn = patch.sourceOut - patch.duration * clip.speed
  return patch
}

function frameCeil(t: number, fps?: number): number {
  return fps ? Math.ceil(t * fps - 1e-6) / fps : t
}

function frameFloor(t: number, fps?: number): number {
  return fps ? Math.floor(t * fps + 1e-6) / fps : t
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi)
}
