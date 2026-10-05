// Макро-op `cutToMarkers` (CONTRACT §6.2): раскладка клипов по слотам между маркерами.
// Чистые функции: проект не меняют, возвращают примитивные ops (removeClip + addClip), которые
// applyOps выполняет в той же транзакции.
import type { Asset, Clip, ClipAnalysis, ClipInput, EditOp, Project, Track } from '@/shared/types.gen'
import { EPS, effectiveSourceOut, itemEnd } from './clipTime'
import { findClip } from './lookup'
import { filterMarkers } from './markerFilter'
import { OpsError } from './ops/errors'

export type CutOp = Extract<EditOp, { op: 'cutToMarkers' }>

export interface CutContext {
  /** Локальный/ИИ-анализ клипа (для `order: "bestMoments"`); без него режим работает как `sequential`. */
  clipAnalysis?: (assetId: string) => ClipAnalysis | undefined
}

export interface Slot {
  start: number
  end: number
}

/**
 * Слоты между соседними моментами `times`. Момент ближе `minLen` к предыдущему оставленному отбрасывается
 * (слот короче кадра бессмыслен), поэтому стыки всегда ровно в оставшихся маркерах.
 */
export function slotsFromTimes(times: readonly number[], minLen: number): Slot[] {
  const kept: number[] = []
  for (const t of [...times].sort((a, b) => a - b)) {
    const last = kept[kept.length - 1]
    if (last === undefined || t - last >= minLen - EPS) kept.push(t)
  }
  const slots: Slot[] = []
  for (let i = 0; i + 1 < kept.length; i++) slots.push({ start: kept[i]!, end: kept[i + 1]! })
  return slots
}

/** Детерминированный ГПСЧ (mulberry32): одинаковый `seed` — одинаковая раскладка на фронте и в тестах. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

interface Source {
  clip: Clip
  /** Используемый диапазон исходника. Для картинок — условный [0, ∞). */
  lo: number
  hi: number
  image: boolean
}

interface Piece {
  sourceIn: number
  sourceOut: number
  speed: number
}

/** Кусок длиной `d` (сек таймлайна) с позиции `from`; если диапазона не хватает — растягивается замедлением. */
function piece(src: Source, from: number, d: number): Piece {
  if (src.image) return { sourceIn: 0, sourceOut: d, speed: 1 }
  const range = src.hi - src.lo
  if (range < d - EPS) return { sourceIn: src.lo, sourceOut: src.hi, speed: range / d }
  const a = Math.min(Math.max(from, src.lo), src.hi - d)
  return { sourceIn: a, sourceOut: a + d, speed: 1 }
}

/** Источник слота по порядку: следующий кусок, при исчерпании клипа — следующий клип, по кругу. */
class SequentialPicker {
  private i = 0
  private pos: number

  constructor(private readonly sources: readonly Source[]) {
    this.pos = sources[0]!.lo
  }

  next(d: number): { src: Source; piece: Piece } {
    const n = this.sources.length
    for (let tries = 0; tries < n; tries++) {
      const src = this.sources[this.i]!
      if (src.image || src.hi - this.pos >= d - EPS) {
        const res = { src, piece: piece(src, this.pos, d) }
        this.pos += d
        if (src.image || src.hi - this.pos < EPS) this.advance()
        return res
      }
      this.advance()
    }
    // ни в одном клипе не осталось d секунд подряд: берём самый длинный целиком (замедление)
    const longest = this.sources.reduce((a, b) => (b.hi - b.lo > a.hi - a.lo ? b : a))
    return { src: longest, piece: piece(longest, longest.lo, d) }
  }

  private advance(): void {
    this.i = (this.i + 1) % this.sources.length
    this.pos = this.sources[this.i]!.lo
  }
}

interface Candidate {
  src: Source
  start: number
  end: number
  score: number
  used: boolean
}

function momentCandidates(
  sources: readonly Source[],
  ctx: CutContext,
  assets: Map<string, Asset>,
): Candidate[] {
  const res: Candidate[] = []
  for (const src of sources) {
    if (src.image) continue
    const analysis = ctx.clipAnalysis?.(src.clip.assetId)
    if (!analysis || !assets.has(src.clip.assetId)) continue
    for (const m of analysis.moments) {
      const start = Math.max(m.start, src.lo)
      const end = Math.min(m.end, src.hi)
      if (end - start > EPS) res.push({ src, start, end, score: m.score, used: false })
    }
  }
  // лучшие первыми; при равенстве — раньше по исходнику
  return res.sort((a, b) => b.score - a.score || a.start - b.start)
}

function collectSources(op: CutOp, p: Project): Source[] {
  const seen = new Set<string>()
  const sources: Source[] = []
  for (const id of op.clipIds) {
    if (seen.has(id)) continue
    seen.add(id)
    const ref = findClip(p, id)
    if (!ref) throw new OpsError('clip_not_found', `Клип ${id} не найден`)
    if (ref.track.kind !== 'video')
      throw new OpsError('incompatible_track', `Клип ${id} лежит на дорожке ${ref.track.kind}, а не video`)
    const asset = p.assets.find((a) => a.id === ref.clip.assetId)
    if (!asset) throw new OpsError('asset_not_found', `Ассет ${ref.clip.assetId} клипа ${id} не найден`)
    const image = asset.kind === 'image'
    sources.push({
      clip: ref.clip,
      lo: ref.clip.sourceIn,
      hi: image ? Infinity : effectiveSourceOut(ref.clip),
      image,
    })
  }
  // по порядку на таймлайне: «следующий кусок» продолжает сюжет клипов
  return sources.sort((a, b) => a.clip.start - b.clip.start)
}

function slotClip(src: Source, start: number, duration: number, pc: Piece): ClipInput {
  const c = src.clip
  const input: ClipInput = {
    type: 'clip',
    assetId: c.assetId,
    start,
    duration,
    sourceIn: pc.sourceIn,
    sourceOut: pc.sourceOut,
    speed: pc.speed,
    reverse: false,
    transform: { x: 0, y: 0, scale: 1, rotation: 0, anchorX: 0, anchorY: 0 },
    opacity: 1,
    blendMode: c.blendMode,
    effects: [],
    markers: [],
  }
  // анимация громкости привязана ко времени исходного клипа и на короткие куски не переносится
  if (c.volume !== undefined) input.volume = typeof c.volume === 'number' ? c.volume : 1
  if (c.color !== undefined) input.color = c.color
  return input
}

/**
 * Раскрывает `cutToMarkers` в примитивные ops (CONTRACT §6.2).
 *
 * 1. Маркеры по `filter` (`filterMarkers`) → слоты между соседними (N маркеров → N−1 слотов).
 * 2. Исходные клипы `clipIds` (видео/картинки) удаляются, на целевую дорожку (`trackId`, по умолчанию дорожка
 *    первого клипа) кладутся клипы по слотам: стык точно в маркере, без пробелов и перекрытий.
 * 3. Кусок для слота: `sequential` — следующий по исходнику; `random` — случайный (ГПСЧ с `seed`, по умолчанию 1);
 *    `bestMoments` — момент с наибольшим `score` из анализа клипа, затем как `sequential`.
 *
 * Новые клипы стандартные: speed 1 (слот длиннее доступного диапазона — замедление), без эффектов и маркеров,
 * transform/opacity по умолчанию; blendMode, константная громкость и цвет берутся с исходного клипа.
 */
export function expandCutToMarkers(p: Project, op: CutOp, ctx: CutContext = {}): EditOp[] {
  if (op.clipIds.length === 0) throw new OpsError('bad_value', 'cutToMarkers: нужен хотя бы один клип')
  const sources = collectSources(op, p)
  const slots = slotsFromTimes(
    filterMarkers(p, op.filter).map((m) => m.t),
    1 / p.fps,
  )
  if (slots.length === 0) throw new OpsError('no_slots', 'Фильтру удовлетворяет меньше двух маркеров')

  const first = findClip(p, sources[0]!.clip.id)!
  let target: Track | undefined = first.track
  if (op.trackId !== undefined) {
    target = p.tracks.find((t) => t.id === op.trackId)
    if (!target) throw new OpsError('track_not_found', `Дорожка ${op.trackId} не найдена`)
    if (target.kind !== 'video')
      throw new OpsError('incompatible_track', `Нарезать можно только на video-дорожку, не ${target.kind}`)
  }

  const removed = new Set(sources.map((s) => s.clip.id))
  const span = { start: slots[0]!.start, end: slots[slots.length - 1]!.end }
  const blocker = target.items.find(
    (i) => !removed.has(i.id) && i.start < span.end - EPS && itemEnd(i) > span.start + EPS,
  )
  if (blocker)
    throw new OpsError(
      'slots_overlap',
      `Слоты [${span.start.toFixed(3)}, ${span.end.toFixed(3)}] перекрывают ${blocker.id} на дорожке ${target.id}`,
    )

  const ops: EditOp[] = [...removed].map((clipId) => ({ op: 'removeClip', clipId }))
  const sequential = new SequentialPicker(sources)
  const rand = mulberry32(op.seed ?? 1)
  const assets = new Map(p.assets.map((a) => [a.id, a]))
  const candidates = op.order === 'bestMoments' ? momentCandidates(sources, ctx, assets) : []

  for (const slot of slots) {
    const d = slot.end - slot.start
    let chosen: { src: Source; piece: Piece }
    if (op.order === 'random') {
      // клип — пропорционально длине диапазона, смещение — равномерно, привязка к кадру проекта
      const weights = sources.map((s) => (s.image ? 1 : s.hi - s.lo))
      let r = rand() * weights.reduce((a, b) => a + b, 0)
      let idx = 0
      while (idx < sources.length - 1 && r >= weights[idx]!) r -= weights[idx++]!
      const src = sources[idx]!
      const room = src.hi - src.lo - d
      const from = src.image || room <= 0 ? src.lo : src.lo + Math.round(rand() * room * p.fps) / p.fps
      chosen = { src, piece: piece(src, from, d) }
    } else if (op.order === 'bestMoments' && candidates.some((c) => !c.used)) {
      const cand = candidates.find((c) => !c.used)!
      cand.used = true
      // момент короче слота — центрируем в окне, длиннее — берём с его начала
      const from = cand.start - Math.max(0, (d - (cand.end - cand.start)) / 2)
      chosen = { src: cand.src, piece: piece(cand.src, from, d) }
    } else {
      chosen = sequential.next(d)
    }
    ops.push({
      op: 'addClip',
      trackId: target.id,
      clip: slotClip(chosen.src, slot.start, d, chosen.piece),
    })
  }
  return ops
}

/** Число слотов, которое получится при данном фильтре (предпросмотр в диалоге). */
export function countSlots(p: Project, op: Pick<CutOp, 'filter'>): number {
  return slotsFromTimes(
    filterMarkers(p, op.filter).map((m) => m.t),
    1 / p.fps,
  ).length
}
