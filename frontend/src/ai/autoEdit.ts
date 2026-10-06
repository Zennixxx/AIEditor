// Выбор музыкального клипа и проверка результата для мастера автоэдита.
import type { OpsResult, Project } from '@/shared/types.gen'

export interface MusicChoice {
  clipId: string
  name: string
  start: number
  end: number
  markers: number
}

/** Музыкальные клипы с маркерами (аудиодорожки и видео со звуком). */
export function musicChoices(p: Project, assetName: (id: string) => string): MusicChoice[] {
  const out: MusicChoice[] = []
  for (const t of p.tracks) {
    if (t.kind === 'fx') continue
    for (const item of t.items) {
      if (item.type !== 'clip' || item.markers.length === 0) continue
      out.push({
        clipId: item.id,
        name: item.label ?? assetName(item.assetId),
        start: item.start,
        end: item.start + item.duration,
        markers: item.markers.length,
      })
    }
  }
  return out
}

export const isOpsResult = (x: unknown): x is OpsResult =>
  typeof x === 'object' && x !== null && Array.isArray((x as OpsResult).ops) && 'explanation' in x
