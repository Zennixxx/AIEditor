// Что играет в момент timeline time `t`: какой клип, какой source time, с какой скоростью.
// Чистые функции без DOM — общие для превью (videoPool), аудио (audioPlan) и тестов.
import { EPS, itemEnd, sourceAtLocal } from '@/model/clipTime'
import { isClip } from '@/model/lookup'
import { solveRemap, speedAt } from '@/model/timeRemap'
import type { Asset, Clip, Project, Track } from '@/shared/types.gen'

export type AssetLookup = (assetId: string) => Asset | undefined

/** Клип дорожки под timeline time `t` (полуинтервал [start, end)). */
export function clipAt(track: Track, t: number): Clip | null {
  for (const item of track.items) {
    if (!isClip(item)) continue
    if (item.start > t + EPS) break // items отсортированы по start
    if (t >= item.start - EPS && t < itemEnd(item) - EPS) return item
  }
  return null
}

/**
 * Скорость чтения исходника в момент `tau` от начала клипа: d(src)/d(τ), сек исходника на сек таймлайна.
 * Отрицательна для reverse. С timeRemap — `k · s(u)` (CONTRACT §5.1).
 */
export function sourceRate(clip: Clip, tau: number): number {
  const dir = clip.reverse ? -1 : 1
  const r = clip.timeRemap
  if (!r) return dir * clip.speed
  const D = clip.duration
  const { k } = solveRemap(r.keyframes, r.fit, D, clip.sourceIn, clip.sourceOut)
  const u = D > 0 ? Math.min(Math.max(tau / D, 0), 1) : 0
  return dir * k * speedAt(r.keyframes, u)
}

export interface Layer {
  track: Track
  clip: Clip
  /** Время от начала клипа. */
  local: number
  /** Source time кадра (с учётом speed / reverse / timeRemap). */
  src: number
  /** d(src)/d(t) при скорости транспорта 1. */
  rate: number
}

export function layerAt(track: Track, clip: Clip, t: number): Layer {
  const local = Math.min(Math.max(t - clip.start, 0), clip.duration)
  return { track, clip, local, src: sourceAtLocal(clip, local), rate: sourceRate(clip, local) }
}

/** Видимые видеодорожки сверху вниз (project.tracks — снизу вверх, CONTRACT §2). */
export function visibleVideoTracks(p: Pick<Project, 'tracks'>): Track[] {
  return p.tracks.filter((t) => t.kind === 'video' && !t.hidden).reverse()
}

/** Видеослои под `t`, верхний первым. */
export function videoLayersAt(p: Pick<Project, 'tracks'>, t: number): Layer[] {
  const res: Layer[] = []
  for (const track of visibleVideoTracks(p)) {
    const clip = clipAt(track, t)
    if (clip) res.push(layerAt(track, clip, t))
  }
  return res
}

/** Верхний видимый клип в момент `t` — его кадр показывает превью (до WebGL-композитинга фазы 4). */
export function topVideoLayer(p: Pick<Project, 'tracks'>, t: number): Layer | null {
  return videoLayersAt(p, t)[0] ?? null
}

/**
 * Клипы видимых видеодорожек, которые начнутся в ближайшие `horizon` секунд после `t`
 * (для предзагрузки `<video>`). При обратном воспроизведении (`direction < 0`) — те, что кончаются до `t`.
 */
export function upcomingVideoClips(
  p: Pick<Project, 'tracks'>,
  t: number,
  horizon: number,
  direction: 1 | -1 = 1,
): { track: Track; clip: Clip; entry: number }[] {
  const res: { track: Track; clip: Clip; entry: number }[] = []
  for (const track of visibleVideoTracks(p)) {
    for (const item of track.items) {
      if (!isClip(item)) continue
      if (direction > 0) {
        if (item.start > t + EPS && item.start <= t + horizon)
          res.push({ track, clip: item, entry: item.start })
      } else {
        const end = itemEnd(item)
        if (end < t - EPS && end >= t - horizon) res.push({ track, clip: item, entry: end })
      }
    }
  }
  return res
}

/** Source time, с которого клип начнёт показываться при входе в него в направлении `direction`. */
export function entrySource(clip: Clip, direction: 1 | -1 = 1): number {
  return sourceAtLocal(clip, direction > 0 ? 0 : clip.duration - EPS)
}

/** Слышимые дорожки: не muted; если есть solo — только solo-дорожки (solo бывает только у аудио). */
export function audibleTracks(p: Pick<Project, 'tracks'>, solo: readonly string[]): Track[] {
  const soloSet = new Set(solo.filter((id) => p.tracks.some((t) => t.id === id)))
  return p.tracks.filter((t) => {
    if (t.kind === 'fx' || t.muted) return false
    return soloSet.size === 0 || soloSet.has(t.id)
  })
}

/** Есть ли у клипа ассета звук: аудио или видео с `hasAudio` (звук видеоклипа идёт из него же). */
export function clipHasSound(asset: Asset | undefined): boolean {
  if (!asset || !asset.derived.audio) return false
  return asset.kind === 'audio' || (asset.kind === 'video' && asset.hasAudio)
}
