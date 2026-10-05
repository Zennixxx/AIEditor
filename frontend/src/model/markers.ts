// Маркеры: перенос анализа музыки в проект (CONTRACT §4), видимость, навигация, ручные правки.
// Чистые функции: проект не меняют, строят ops для store.dispatch.
import type {
  Clip,
  EditOp,
  Marker,
  MarkerInput,
  MarkerKind,
  MusicAnalysis,
  MusicAnalysisParams,
  Project,
  SectionInput,
} from '@/shared/types.gen'
import { snapToFrame } from '@/shared/time'
import { EPS, effectiveSourceOut, sourceAtTimeline, timelineAtSource } from './clipTime'
import { allClips, findClip, findMarker } from './lookup'
import { SECTION_LABELS } from './sections'

export const MARKER_KINDS: readonly MarkerKind[] = ['bass', 'beat', 'downbeat', 'onset', 'manual', 'ai']

/** Виды, которые создаёт анализ: «Переанализировать» заменяет именно их, `manual`/`ai` сохраняются. */
export const AUTO_KINDS: readonly MarkerKind[] = ['bass', 'beat', 'downbeat', 'onset']

export const MARKER_COLORS: Record<MarkerKind, string> = {
  bass: '#ff4d5e',
  beat: '#8a90a0',
  downbeat: '#ffffff',
  onset: '#4dc3ff',
  manual: '#ffd84d',
  ai: '#b18cff',
}

export const SECTION_COLORS: Record<string, string> = {
  intro: '#4a7bd0',
  verse: '#3f9a7a',
  build: '#d09a3a',
  drop: '#d04a5e',
  break: '#8a6bd0',
  outro: '#5a6b8a',
  other: '#6b7280',
}

export function markerColor(m: Pick<Marker, 'kind' | 'color'>): string {
  return m.color ?? MARKER_COLORS[m.kind]
}

// --- видимость --------------------------------------------------------------------------------

export interface MarkerVisibility {
  /** Порог силы 0..1: маркеры слабее скрыты. */
  minStrength: number
  /** Показываемые виды. */
  kinds: readonly MarkerKind[]
}

/** Параметры анализа по умолчанию (CONTRACT §4). */
export const DEFAULT_ANALYSIS_PARAMS: MusicAnalysisParams = {
  bassCutoffHz: 150,
  sensitivity: 0.5,
  minGapSec: 0.12,
  useStems: false,
}

/** По умолчанию скрыт только `onset` (CONTRACT §4). */
export const DEFAULT_VISIBILITY: MarkerVisibility = {
  minStrength: 0,
  kinds: ['bass', 'beat', 'downbeat', 'manual', 'ai'],
}

export function isMarkerVisible(m: Pick<Marker, 'kind' | 'strength'>, vis: MarkerVisibility): boolean {
  return vis.kinds.includes(m.kind) && m.strength >= vis.minStrength - 1e-9
}

// --- перенос анализа --------------------------------------------------------------------------

const clamp01 = (v: number) => Math.min(1, Math.max(0, v))

/** Маркеры из анализа в source time (CONTRACT §4): bass, downbeat, beat (без совпадающих с даунбитом ±1 мс), onset. */
export function analysisMarkers(a: MusicAnalysis): MarkerInput[] {
  const res: MarkerInput[] = []
  for (const b of a.bass) res.push({ t: b.t, kind: 'bass', strength: clamp01(b.strength) })
  for (const t of a.downbeats) res.push({ t, kind: 'downbeat', strength: 1 })
  const downs = [...a.downbeats].sort((x, y) => x - y)
  const isDownbeat = (t: number) => {
    let lo = 0
    let hi = downs.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (downs[mid]! < t) lo = mid + 1
      else hi = mid
    }
    return [downs[lo - 1], downs[lo]].some((d) => d !== undefined && Math.abs(d - t) <= 1e-3 + 1e-9)
  }
  for (const t of a.beats) if (!isDownbeat(t)) res.push({ t, kind: 'beat', strength: 1 })
  for (const o of a.onsets) res.push({ t: o.t, kind: 'onset', strength: clamp01(o.strength) })
  return res.filter((m) => Number.isFinite(m.t) && m.t >= 0).sort((x, y) => x.t - y.t)
}

/** Секции анализа → валидный список для setSections (сортировка, обрезка перекрытий, отбрасывание пустых). */
export function analysisSections(a: MusicAnalysis): SectionInput[] {
  const res: SectionInput[] = []
  let prevEnd = -Infinity
  for (const s of [...a.sections].sort((x, y) => x.start - y.start)) {
    const start = Math.max(s.start, prevEnd, 0)
    if (!(s.end > start + EPS) || !SECTION_LABELS.includes(s.label)) continue
    const input: SectionInput = { start, end: s.end, label: s.label, energy: clamp01(s.energy) }
    if (s.description) input.description = s.description
    res.push(input)
    prevEnd = s.end
  }
  return res
}

/** Клип, которому можно приписать анализ музыки: клип аудиодорожки или видеоклип со звуком. */
export function canHoldAnalysis(p: Project, clipId: string): boolean {
  const ref = findClip(p, clipId)
  if (!ref) return false
  if (ref.track.kind === 'audio') return true
  return ref.track.kind === 'video' && !!p.assets.find((a) => a.id === ref.clip.assetId)?.hasAudio
}

/**
 * Одна транзакция переноса анализа на клип (CONTRACT §4): `removeMarkers` старых автоматических
 * (`bass`/`beat`/`downbeat`/`onset`) + `addMarkers` + `setSections`. Маркеры `manual`/`ai` остаются.
 */
export function planApplyAnalysis(p: Project, clipId: string, analysis: MusicAnalysis): EditOp[] {
  const ref = findClip(p, clipId)
  if (!ref || !canHoldAnalysis(p, clipId)) return []
  const ops: EditOp[] = []
  const old = ref.clip.markers.filter((m) => AUTO_KINDS.includes(m.kind)).map((m) => m.id)
  if (old.length > 0) ops.push({ op: 'removeMarkers', markerIds: old })
  ops.push({ op: 'addMarkers', target: { clipId }, markers: analysisMarkers(analysis) })
  ops.push({ op: 'setSections', target: { clipId }, sections: analysisSections(analysis) })
  return ops
}

// --- маркеры в timeline time ------------------------------------------------------------------

export interface TimelineMarker {
  marker: Marker
  /** Клип-владелец или null (маркер проекта). */
  clipId: string | null
  /** Позиция на таймлайне, сек. */
  t: number
}

/** Все маркеры проекта в timeline time (маркеры клипов вне видимого диапазона клипа не включаются), по возрастанию t. */
export function timelineMarkers(p: Project, vis?: MarkerVisibility): TimelineMarker[] {
  const res: TimelineMarker[] = []
  for (const m of p.markers)
    if (!vis || isMarkerVisible(m, vis)) res.push({ marker: m, clipId: null, t: m.t })
  for (const clip of allClips(p)) {
    for (const m of clip.markers) {
      if (vis && !isMarkerVisible(m, vis)) continue
      const t = timelineAtSource(clip, m.t)
      if (t !== null) res.push({ marker: m, clipId: clip.id, t })
    }
  }
  return res.sort((a, b) => a.t - b.t)
}

/** Следующий (dir = 1) или предыдущий (dir = −1) маркер относительно `t`; `list` отсортирован по t. */
export function neighborMarkerTime(list: readonly TimelineMarker[], t: number, dir: 1 | -1): number | null {
  const eps = 1e-4
  if (dir === 1) return list.find((m) => m.t > t + eps)?.t ?? null
  for (let i = list.length - 1; i >= 0; i--) if (list[i]!.t < t - eps) return list[i]!.t
  return null
}

/**
 * Прореживание при малом зуме: маркеры ближе `minPx` друг к другу (по цепочке) образуют кластер,
 * рисуется только сильнейший (выделенные побеждают). Кластеры считаются отдельно для каждого клипа (и проекта) и для каждого
 * вида маркеров: плотные `beat`/`downbeat` не должны вытеснять `bass`.
 */
export function thinMarkers(
  list: readonly TimelineMarker[],
  pxPerSec: number,
  minPx = 3,
  selected?: ReadonlySet<string>,
): TimelineMarker[] {
  const groups = new Map<string, TimelineMarker[]>()
  for (const m of list) {
    const key = `${m.clipId ?? ''}|${m.marker.kind}`
    const g = groups.get(key)
    if (g) g.push(m)
    else groups.set(key, [m])
  }
  const out: TimelineMarker[] = []
  const score = (m: TimelineMarker) => (selected?.has(m.marker.id) ? 2 : 0) + m.marker.strength
  for (const group of groups.values()) {
    let best: TimelineMarker | null = null
    let last: TimelineMarker | null = null
    for (const m of group) {
      if (last && (m.t - last.t) * pxPerSec >= minPx) {
        out.push(best!)
        best = null
      }
      if (!best || score(m) > score(best)) best = m
      last = m
    }
    if (best) out.push(best)
  }
  return out.sort((a, b) => a.t - b.t)
}

// --- ручные правки ----------------------------------------------------------------------------

/** Клип аудиодорожки среди `ids`, под которым находится timeline-время `t`. */
function audioClipAt(p: Project, ids: readonly string[], t: number): Clip | null {
  for (const id of ids) {
    const ref = findClip(p, id)
    if (
      ref &&
      ref.track.kind === 'audio' &&
      ref.clip.start - EPS <= t &&
      t <= ref.clip.start + ref.clip.duration + EPS
    )
      return ref.clip
  }
  return null
}

/**
 * `M`: маркер `manual` под плейхедом — на выделенный аудиоклип (в source time), иначе маркер проекта.
 * Время квантуется к кадру.
 */
export function planAddMarker(p: Project, playhead: number, selected: readonly string[]): EditOp[] {
  const t = snapToFrame(playhead, p.fps)
  const clip = audioClipAt(p, selected, t)
  if (clip) {
    const src = Math.min(Math.max(sourceAtTimeline(clip, t), clip.sourceIn), effectiveSourceOut(clip))
    return [
      { op: 'addMarkers', target: { clipId: clip.id }, markers: [{ t: src, kind: 'manual', strength: 1 }] },
    ]
  }
  return [{ op: 'addMarkers', target: 'project', markers: [{ t, kind: 'manual', strength: 1 }] }]
}

export function planDeleteMarkers(p: Project, ids: readonly string[]): EditOp[] {
  const existing = ids.filter((id) => findMarker(p, id))
  return existing.length > 0 ? [{ op: 'removeMarkers', markerIds: existing }] : []
}

export interface MarkerOrigin {
  id: string
  clipId: string | null
  /** Позиция на таймлайне в начале перетаскивания. */
  t: number
}

/** Позиции перетаскиваемых маркеров в timeline time (фиксируются в начале drag). */
export function markerOrigins(p: Project, ids: readonly string[]): MarkerOrigin[] {
  const res: MarkerOrigin[] = []
  for (const id of ids) {
    const ref = findMarker(p, id)
    if (!ref) continue
    if (!ref.clip) res.push({ id, clipId: null, t: ref.marker.t })
    else {
      const t = timelineAtSource(ref.clip, ref.marker.t)
      if (t !== null) res.push({ id, clipId: ref.clip.id, t })
    }
  }
  return res
}

/**
 * Сдвиг маркеров на `delta` сек таймлайна от исходных позиций: маркеры клипа пересчитываются в source time
 * (с учётом speed/timeRemap/reverse) и остаются в видимом диапазоне клипа, маркеры проекта — не раньше 0.
 */
export function planMoveMarkers(p: Project, origins: readonly MarkerOrigin[], delta: number): EditOp[] {
  const ops: EditOp[] = []
  for (const o of origins) {
    const target = Math.max(0, o.t + delta)
    if (o.clipId === null) {
      ops.push({ op: 'updateMarker', markerId: o.id, patch: { t: target } })
      continue
    }
    const clip = findClip(p, o.clipId)?.clip
    if (!clip) continue
    const t0 = clip.start
    const t1 = clip.start + clip.duration
    const src = sourceAtTimeline(clip, Math.min(Math.max(target, t0), t1))
    ops.push({
      op: 'updateMarker',
      markerId: o.id,
      patch: { t: Math.min(Math.max(src, clip.sourceIn), effectiveSourceOut(clip)) },
    })
  }
  return ops
}
