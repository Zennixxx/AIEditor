import type { Clip, EditOp, RampKeyframe, TimeRemap } from '@/shared/types.gen'

const MIN_GAP = 0.02

function nearest(list: readonly number[], target: number): number | null {
  let best: number | null = null
  for (const v of list) if (best === null || Math.abs(v - target) < Math.abs(best - target)) best = v
  return best
}

function piecewise(anchors: readonly [number, number][], u: number): number {
  for (let i = 0; i + 1 < anchors.length; i++) {
    const [x0, y0] = anchors[i]!
    const [x1, y1] = anchors[i + 1]!
    if (u <= x1 || i + 2 === anchors.length) {
      const span = x1 - x0
      return span > 0 ? y0 + ((u - x0) / span) * (y1 - y0) : y0
    }
  }
  return u
}

export function slowKeys(keys: readonly RampKeyframe[]): number[] {
  const min = Math.min(...keys.map((k) => k.speed))
  const res: number[] = []
  keys.forEach((k, i) => {
    if (k.u > 0 && k.u < 1 && k.speed <= min + 1e-9) res.push(i)
  })
  return res
}

export function slowAnchors(
  keys: readonly RampKeyframe[],
  markers: readonly number[],
): [number, number][] | null {
  const slow = slowKeys(keys)
  const inner = [...markers].filter((u) => u > MIN_GAP && u < 1 - MIN_GAP).sort((a, b) => a - b)
  if (slow.length === 0 || inner.length === 0) return null
  const a = keys[slow[0]!]!.u
  const b = keys[slow[slow.length - 1]!]!.u
  if (slow.length === 1 || b - a < 1e-9) return [[a, nearest(inner, a)!]]
  const m1 = nearest(inner, a)!
  const m2 = nearest(
    inner.filter((u) => u > m1 + MIN_GAP),
    b,
  )
  if (m2 !== null)
    return [
      [a, m1],
      [b, m2],
    ]
  const half = (b - a) / 2
  const c = Math.min(Math.max(nearest(inner, (a + b) / 2)!, MIN_GAP + half), 1 - MIN_GAP - half)
  return [
    [a, c - half],
    [b, c + half],
  ]
}

export function fitRampToMarkers(
  remap: TimeRemap,
  markers: readonly number[],
): { remap: TimeRemap; matched: number } {
  const anchors = slowAnchors(remap.keyframes, markers)
  if (!anchors) return { remap: structuredClone(remap), matched: 0 }
  const pts: [number, number][] = [[0, 0], ...anchors, [1, 1]]
  const keyframes = remap.keyframes.map((k) =>
    k.u <= 0 || k.u >= 1 ? { ...k } : { ...k, u: Math.min(Math.max(piecewise(pts, k.u), 0), 1) },
  )
  return { remap: { ...structuredClone(remap), keyframes }, matched: anchors.length }
}

export function markersInClip(
  clip: Pick<Clip, 'start' | 'duration'>,
  times: readonly number[],
  fps: number,
): number[] {
  const frame = 1 / fps
  return times
    .filter((t) => t > clip.start + frame && t < clip.start + clip.duration - frame)
    .map((t) => (t - clip.start) / clip.duration)
}

export function planVelocity(
  clip: Pick<Clip, 'id' | 'start' | 'duration'>,
  preset: TimeRemap,
  markerTimes: readonly number[],
  fps: number,
): { ops: EditOp[]; matched: number } {
  const { remap, matched } = fitRampToMarkers(preset, markersInClip(clip, markerTimes, fps))
  return { ops: [{ op: 'setTimeRemap', clipId: clip.id, timeRemap: remap }], matched }
}
