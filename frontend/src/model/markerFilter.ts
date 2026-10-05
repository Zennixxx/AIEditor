// Фильтр маркеров для макро-ops (CONTRACT §6, MarkerFilter): какие маркеры музыкального клипа участвуют.
// Чистые функции: проект не меняют.
import type { Clip, MarkerFilter, MarkerKind, Project } from '@/shared/types.gen'
import { EPS, timelineAtSource } from './clipTime'
import { findClip, isClip } from './lookup'
import type { TimelineMarker } from './markers'
import { timelineSections } from './sections'
import { OpsError } from './ops/errors'

/** Виды маркеров, если `filter.kinds` не задан (CONTRACT §4). */
export const DEFAULT_FILTER_KINDS: readonly MarkerKind[] = ['bass']

/**
 * Музыкальный клип фильтра: `musicClipId`, иначе первый (по порядку дорожек и start) клип аудиодорожки
 * с маркерами, а если маркеров нигде нет — просто первый клип аудиодорожки.
 */
export function resolveMusicClip(p: Project, musicClipId?: string): Clip | null {
  if (musicClipId !== undefined) {
    const ref = findClip(p, musicClipId)
    if (!ref) throw new OpsError('clip_not_found', `Музыкальный клип ${musicClipId} не найден`)
    return ref.clip
  }
  let first: Clip | null = null
  for (const track of p.tracks) {
    if (track.kind !== 'audio') continue
    for (const item of track.items) {
      if (!isClip(item)) continue
      if (item.markers.length > 0) return item
      first ??= item
    }
  }
  return first
}

function assertPositiveInt(v: number, name: string, min: number): void {
  if (!Number.isInteger(v) || v < min) throw new OpsError('bad_value', `${name} должно быть целым ≥ ${min}`)
}

/**
 * Маркеры, прошедшие фильтр, в timeline time по возрастанию.
 *
 * Источник — маркеры музыкального клипа (пересчитанные из source time; вне видимого диапазона клипа
 * отбрасываются); если музыкального клипа нет — маркеры проекта. Порядок применения:
 * `kinds` (по умолчанию `["bass"]`) → `minStrength` → `sectionLabels` → `range` → `every`/`offset` по оставшимся.
 */
export function filterMarkers(p: Project, filter: MarkerFilter = {}): TimelineMarker[] {
  const every = filter.every ?? 1
  const offset = filter.offset ?? 0
  assertPositiveInt(every, 'filter.every', 1)
  assertPositiveInt(offset, 'filter.offset', 0)
  if (filter.minStrength !== undefined && !(filter.minStrength >= 0 && filter.minStrength <= 1))
    throw new OpsError('bad_value', 'filter.minStrength вне 0..1')
  if (filter.range && !(filter.range.start <= filter.range.end))
    throw new OpsError('bad_value', 'filter.range: start должен быть ≤ end')

  const kinds = filter.kinds ?? DEFAULT_FILTER_KINDS
  const music = resolveMusicClip(p, filter.musicClipId)
  let list: TimelineMarker[] = []
  if (music) {
    for (const marker of music.markers) {
      const t = timelineAtSource(music, marker.t)
      if (t !== null) list.push({ marker, clipId: music.id, t })
    }
  } else {
    list = p.markers.map((marker) => ({ marker, clipId: null, t: marker.t }))
  }

  const labels = filter.sectionLabels
  const sections = labels
    ? timelineSections(p).filter(
        (s) => labels.includes(s.label) && (s.clipId === null || s.clipId === music?.id),
      )
    : []
  const { range } = filter
  list = list.filter(
    ({ marker, t }) =>
      kinds.includes(marker.kind) &&
      marker.strength >= (filter.minStrength ?? 0) - 1e-9 &&
      (!labels || sections.some((s) => t >= s.start - EPS && t < s.end - EPS)) &&
      (!range || (t >= range.start - EPS && t <= range.end + EPS)),
  )
  list.sort((a, b) => a.t - b.t)
  return list.filter((_, i) => i >= offset && (i - offset) % every === 0)
}
