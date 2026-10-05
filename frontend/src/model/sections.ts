// Секции (CONTRACT §2 инвариант 8, §6.1 п. 9–11): проверка списков, пересчёт секций клипа в timeline time.
import type { Clip, Project, Section, SectionLabel } from '@/shared/types.gen'
import { EPS, effectiveSourceOut, timelineAtSource } from './clipTime'
import { allClips } from './lookup'

export const SECTION_LABELS: readonly SectionLabel[] = [
  'intro',
  'verse',
  'build',
  'drop',
  'break',
  'outro',
  'other',
]

/** Описание проблемы списка секций или null, если список корректен (отсортирован, start < end, без перекрытий). */
export function sectionListError(list: readonly Pick<Section, 'start' | 'end'>[]): string | null {
  for (let i = 0; i < list.length; i++) {
    const s = list[i]!
    if (!Number.isFinite(s.start) || !Number.isFinite(s.end)) return 'start/end должны быть конечными числами'
    if (!(s.start < s.end)) return `секция ${i}: start должен быть меньше end`
    const prev = list[i - 1]
    if (prev && s.start < prev.end - EPS) return `секции ${i - 1} и ${i} перекрываются или не отсортированы`
  }
  return null
}

export interface TimelineSection {
  /** ID секции (из проекта или клипа). */
  id: string
  /** Клип-владелец (секции музыки) или null (секции композиции). */
  clipId: string | null
  start: number
  end: number
  label: SectionLabel
  energy: number
  description?: string
}

/**
 * Секция клипа в timeline time, обрезанная по видимому диапазону клипа [sourceIn, sourceOut];
 * null, если секция целиком вне клипа. Учитывает speed / timeRemap / reverse.
 */
export function sectionSpanOnTimeline(
  clip: Clip,
  s: Pick<Section, 'start' | 'end'>,
): [number, number] | null {
  const lo = Math.max(s.start, clip.sourceIn)
  const hi = Math.min(s.end, effectiveSourceOut(clip))
  if (!(hi - lo > EPS)) return null
  const a = timelineAtSource(clip, lo)
  const b = timelineAtSource(clip, hi)
  if (a === null || b === null) return null
  const t0 = Math.min(a, b)
  const t1 = Math.max(a, b)
  return t1 - t0 > EPS ? [t0, t1] : null
}

/** Все секции проекта в timeline time: секции композиции + секции клипов (пересчитанные и обрезанные). */
export function timelineSections(p: Project): TimelineSection[] {
  const res: TimelineSection[] = p.sections.map((s) => ({ ...s, clipId: null }))
  for (const clip of allClips(p)) {
    for (const s of clip.sections ?? []) {
      const span = sectionSpanOnTimeline(clip, s)
      if (!span) continue
      res.push({ ...s, clipId: clip.id, start: span[0], end: span[1] })
    }
  }
  return res.sort((a, b) => a.start - b.start)
}
