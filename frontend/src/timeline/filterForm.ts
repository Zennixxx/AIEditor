// Состояние формы фильтра маркеров (MarkerFilterFields) и перевод в MarkerFilter (CONTRACT §6).
import type { MarkerFilter, MarkerKind, Project, SectionLabel } from '@/shared/types.gen'

export interface FilterForm {
  musicClipId: string
  kinds: MarkerKind[]
  minStrength: number
  every: number
  offset: number
  sectionLabels: SectionLabel[]
  useRange: boolean
  rangeStart: number
  rangeEnd: number
}

export function initialFilterForm(p: Project, minStrength: number): FilterForm {
  return {
    musicClipId: '',
    kinds: ['bass'],
    minStrength,
    every: 1,
    offset: 0,
    sectionLabels: [],
    useRange: false,
    rangeStart: 0,
    rangeEnd: Math.max(1, Math.round(p.duration)),
  }
}

export function filterFromForm(f: FilterForm): MarkerFilter {
  const filter: MarkerFilter = { kinds: f.kinds, every: f.every, offset: f.offset }
  if (f.minStrength > 0) filter.minStrength = f.minStrength
  if (f.musicClipId) filter.musicClipId = f.musicClipId
  if (f.sectionLabels.length > 0) filter.sectionLabels = f.sectionLabels
  if (f.useRange) filter.range = { start: f.rangeStart, end: f.rangeEnd }
  return filter
}

export function toggle<T>(list: readonly T[], item: T): T[] {
  return list.includes(item) ? list.filter((x) => x !== item) : [...list, item]
}
