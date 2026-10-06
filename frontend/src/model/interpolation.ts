import type { Asset, Clip, InterpolateRequest } from '@/shared/types.gen'
import { EPS, effectiveSourceOut } from './clipTime'
import { solveRemap, speedAt } from './timeRemap'

export const SLOW_SPEED = 0.8
export const RANGE_MARGIN = 0.1
export const MAX_FACTOR = 16
const SPEED_SAMPLES = 64
const BLEND_EPS = 0.01

type AssetLookup = (assetId: string) => Asset | undefined
type TimingClip = Pick<Clip, 'duration' | 'sourceIn' | 'sourceOut' | 'speed' | 'reverse' | 'timeRemap'>

export function minEffectiveSpeed(clip: TimingClip): number {
  const r = clip.timeRemap
  if (!r) return clip.speed
  const { k } = solveRemap(r.keyframes, r.fit, clip.duration, clip.sourceIn, clip.sourceOut)
  let min = Infinity
  for (const key of r.keyframes) min = Math.min(min, speedAt(r.keyframes, key.u))
  for (let i = 0; i <= SPEED_SAMPLES; i++) min = Math.min(min, speedAt(r.keyframes, i / SPEED_SAMPLES))
  return k * min
}

export function nextPow2(n: number): number {
  let p = 1
  while (p < n) p *= 2
  return p
}

export function requiredFactor(
  clip: TimingClip,
  asset: Asset | undefined,
  projectFps: number,
): number | null {
  if (!asset || asset.kind !== 'video' || asset.parent) return null
  const fps = asset.fps ?? 0
  if (!(fps > 0)) return null
  const minSpeed = minEffectiveSpeed(clip)
  if (!(minSpeed > 0) || minSpeed >= SLOW_SPEED || fps * minSpeed >= projectFps) return null
  return Math.min(MAX_FACTOR, Math.max(2, nextPow2(Math.ceil(projectFps / (fps * minSpeed) - 1e-9))))
}

export function interpolationRange(
  clip: TimingClip,
  asset: Asset,
): Pick<InterpolateRequest, 'sourceIn' | 'sourceOut'> {
  const out = effectiveSourceOut(clip)
  const lo = Math.min(clip.sourceIn, out)
  const hi = Math.max(clip.sourceIn, out)
  return {
    sourceIn: Math.max(0, lo - RANGE_MARGIN),
    sourceOut: Math.min(asset.duration, hi + RANGE_MARGIN),
  }
}

export function coversClip(derived: Asset, clip: Pick<Clip, 'assetId'> & TimingClip): boolean {
  const p = derived.parent
  if (!p || p.assetId !== clip.assetId || derived.status !== 'ready') return false
  const out = effectiveSourceOut(clip)
  const lo = Math.min(clip.sourceIn, out)
  const hi = Math.max(clip.sourceIn, out)
  const frame = derived.fps ? p.factor / derived.fps : 0
  return p.sourceIn <= lo + EPS && p.sourceOut + frame >= hi - EPS
}

export function usableInterpolation(
  clip: Pick<Clip, 'assetId' | 'interpolatedAssetId'> & TimingClip,
  lookup: AssetLookup,
): Asset | null {
  if (!clip.interpolatedAssetId) return null
  const derived = lookup(clip.interpolatedAssetId)
  return derived && coversClip(derived, clip) ? derived : null
}

export interface FrameBlend {
  next: number
  weight: number
  fps: number
}

export function blendFrames(src: number, fps: number): FrameBlend | null {
  const pos = src * fps
  const index = Math.floor(pos + 1e-6)
  const weight = pos - index
  if (weight < BLEND_EPS || weight > 1 - BLEND_EPS) return null
  return { next: (index + 1) / fps, weight, fps }
}

export function layerBlend(
  clip: Clip,
  src: number,
  rate: number,
  lookup: AssetLookup | undefined,
): FrameBlend | null {
  if (!lookup || !clip.timeRemap?.frameBlend || Math.abs(rate) >= 1 - EPS) return null
  const asset = lookup(clip.assetId)
  if (!asset || asset.kind !== 'video' || !asset.fps) return null
  if (usableInterpolation(clip, lookup)) return null
  return blendFrames(src, asset.fps)
}
