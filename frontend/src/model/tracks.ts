// Порядок дорожек на экране и их перестановка.
// project.tracks: порядок отрисовки снизу вверх (tracks[0] — нижний слой, CONTRACT §2).
// На экране (как в Premiere): сверху визуальные дорожки (video/fx) — верхний слой первым, ниже аудио по порядку.
import type { EditOp, Project, Track } from '@/shared/types.gen'

export type TrackGroup = 'visual' | 'audio'

export function trackGroup(t: Pick<Track, 'kind'>): TrackGroup {
  return t.kind === 'audio' ? 'audio' : 'visual'
}

export function displayOrder(p: Pick<Project, 'tracks'>): Track[] {
  const visual = p.tracks.filter((t) => t.kind !== 'audio').reverse()
  const audio = p.tracks.filter((t) => t.kind === 'audio')
  return [...visual, ...audio]
}

/**
 * Переставляет дорожку на позицию `toDisplayIndex` экранного порядка (в пределах своей группы:
 * визуальные дорожки не смешиваются с аудио). Мутирует `p` (используется внутри transact).
 * Возвращает true, если порядок изменился.
 */
export function moveTrackInDisplay(
  p: Pick<Project, 'tracks'>,
  trackId: string,
  toDisplayIndex: number,
): boolean {
  const display = displayOrder(p)
  const track = display.find((t) => t.id === trackId)
  if (!track) return false
  const group = trackGroup(track)
  const groupDisplay = display.filter((t) => trackGroup(t) === group)
  const offset = group === 'visual' ? 0 : display.length - groupDisplay.length
  const from = groupDisplay.indexOf(track)
  const to = Math.max(0, Math.min(groupDisplay.length - 1, toDisplayIndex - offset))
  if (from === to) return false
  groupDisplay.splice(from, 1)
  groupDisplay.splice(to, 0, track)
  // визуальная группа в массиве идёт в обратном экранному порядке
  const arrayOrder = group === 'visual' ? [...groupDisplay].reverse() : groupDisplay
  let k = 0
  const next = p.tracks.map((t) => (trackGroup(t) === group ? arrayOrder[k++]! : t))
  p.tracks.splice(0, p.tracks.length, ...next)
  return true
}

/**
 * Op `moveTrack` для перестановки дорожки на позицию `toDisplayIndex` экранного порядка
 * (в пределах своей группы). null — порядок не меняется.
 */
export function planTrackMove(
  p: Pick<Project, 'tracks'>,
  trackId: string,
  toDisplayIndex: number,
): Extract<EditOp, { op: 'moveTrack' }> | null {
  const copy = { tracks: [...p.tracks] }
  if (!moveTrackInDisplay(copy, trackId, toDisplayIndex)) return null
  // перестановка внутри группы — перенос одной дорожки, остальные сохраняют порядок,
  // поэтому её итоговый индекс и есть `index` op moveTrack (CONTRACT §6)
  return { op: 'moveTrack', trackId, index: copy.tracks.findIndex((t) => t.id === trackId) }
}

/** Индекс в project.tracks для новой дорожки: визуальная — поверх всех визуальных, аудио — в конец. */
export function newTrackIndex(p: Pick<Project, 'tracks'>, kind: Track['kind']): number {
  if (kind === 'audio') return p.tracks.length
  let last = -1
  p.tracks.forEach((t, i) => {
    if (t.kind !== 'audio') last = i
  })
  return last + 1
}
