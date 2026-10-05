// Планировщики UI-действий: превращают намерение пользователя в список edit-ops (CONTRACT §6).
// Чистые функции: проект не меняют, только строят ops для store.dispatch.
import type {
  Asset,
  Clip,
  EditOp,
  EffectItem,
  Project,
  Track,
  TrackItem,
  TrackKind,
} from '@/shared/types.gen'
import { EPS, itemEnd } from './clipTime'
import { trimClipData, type TrimEdge } from './clipEdit'
import { findItem, isClip, trackAcceptsAsset } from './lookup'
import { clipFromAsset, assetClipDuration, trackInput } from './project'
import { newTrackIndex } from './tracks'

interface Span {
  start: number
  end: number
}

function overlaps(a: Span, b: Span): boolean {
  return a.start < b.end - EPS && b.start < a.end - EPS
}

function isFree(track: Track, span: Span, ignore?: ReadonlySet<string>): boolean {
  return track.items.every((i) => ignore?.has(i.id) || !overlaps(span, { start: i.start, end: itemEnd(i) }))
}

// --- разрезание -------------------------------------------------------------------------------

/**
 * Ctrl+K: разрезать по `t` выделенные клипы под плейхедом, а если таких нет — все клипы под плейхедом
 * на незаблокированных дорожках.
 */
export function planSplitAt(p: Project, t: number, selected: readonly string[] = []): EditOp[] {
  const under: Clip[] = []
  for (const track of p.tracks) {
    if (track.locked) continue
    for (const item of track.items) {
      if (isClip(item) && item.start + EPS < t && t < itemEnd(item) - EPS) under.push(item)
    }
  }
  const sel = new Set(selected)
  const chosen = under.some((c) => sel.has(c.id)) ? under.filter((c) => sel.has(c.id)) : under
  return chosen.map((c) => ({ op: 'splitClip', clipId: c.id, at: t }))
}

// --- удаление ---------------------------------------------------------------------------------

/** Delete / Shift+Delete (ripple): удаляет клипы и эффекты fx-дорожек. */
export function planDelete(p: Project, ids: readonly string[], ripple = false): EditOp[] {
  const refs = ids
    .map((id) => findItem(p, id))
    .filter((r): r is NonNullable<typeof r> => !!r && !r.track.locked)
    // ripple: с конца, чтобы сдвиги не влияли на ещё не удалённые элементы
    .sort((a, b) => b.item.start - a.item.start)
  const ops: EditOp[] = []
  for (const { track, item } of refs) {
    if (isClip(item)) {
      ops.push(
        ripple ? { op: 'removeClip', clipId: item.id, ripple: true } : { op: 'removeClip', clipId: item.id },
      )
    } else {
      ops.push({ op: 'removeEffect', effectId: item.id })
      if (ripple) {
        for (const other of track.items) {
          if (other.start >= itemEnd(item) - EPS && !ids.includes(other.id)) {
            ops.push({
              op: 'updateEffect',
              effectId: other.id,
              patch: { start: other.start - item.duration },
            })
          }
        }
      }
    }
  }
  return ops
}

// --- перемещение ------------------------------------------------------------------------------

export interface ItemMove {
  id: string
  start: number
  trackId: string
}

/**
 * Перемещение группы элементов. Если в целевом месте занято:
 * - `rippleInsert` (Alt) — элементы дорожки, начиная с точки вставки, сдвигаются вправо;
 * - иначе — null (перемещение отменяется, элементы возвращаются на место).
 */
export function planMove(
  p: Project,
  moves: readonly ItemMove[],
  opts: { rippleInsert?: boolean } = {},
): EditOp[] | null {
  const moving = new Set(moves.map((m) => m.id))
  const resolved: { m: ItemMove; item: TrackItem; from: Track; to: Track }[] = []
  for (const m of moves) {
    const ref = findItem(p, m.id)
    const to = p.tracks.find((t) => t.id === m.trackId)
    if (!ref || !to || to.locked || ref.track.locked) return null
    if (m.start < -EPS) return null
    const compatible = isClip(ref.item) ? to.kind === ref.track.kind : to.kind === 'fx'
    if (!compatible) return null
    resolved.push({ m, item: ref.item, from: ref.track, to })
  }

  const ops: EditOp[] = []
  const byTrack = new Map<Track, Span[]>()
  for (const r of resolved) {
    const list = byTrack.get(r.to) ?? []
    const span = { start: r.m.start, end: r.m.start + r.item.duration }
    if (list.some((s) => overlaps(s, span))) return null // перемещаемые не должны налезать друг на друга
    list.push(span)
    byTrack.set(r.to, list)
  }

  for (const [track, spans] of byTrack) {
    const statics = track.items.filter((i) => !moving.has(i.id))
    const conflict = statics.some((i) => spans.some((s) => overlaps(s, { start: i.start, end: itemEnd(i) })))
    if (!conflict) continue
    if (!opts.rippleInsert) return null
    const point = Math.min(...spans.map((s) => s.start))
    const maxEnd = Math.max(...spans.map((s) => s.end))
    const affected = statics.filter((i) => itemEnd(i) > point + EPS)
    const minStart = Math.min(...affected.map((i) => i.start))
    const shift = Math.max(0, maxEnd - minStart)
    if (shift <= 0) continue
    for (const i of affected) ops.push(shiftOp(i, i.start + shift))
  }

  for (const { m, item, from, to } of resolved) {
    if (isClip(item)) {
      ops.push(
        to === from
          ? { op: 'moveClip', clipId: item.id, start: m.start }
          : { op: 'moveClip', clipId: item.id, start: m.start, trackId: to.id },
      )
    } else if (to === from) {
      ops.push({ op: 'updateEffect', effectId: item.id, patch: { start: m.start } })
    } else {
      const { type: _type, ...rest } = item
      ops.push({ op: 'removeEffect', effectId: item.id })
      ops.push({ op: 'addEffect', target: { trackId: to.id }, effect: { ...rest, start: m.start } })
    }
  }
  return ops
}

function shiftOp(item: TrackItem, start: number): EditOp {
  return isClip(item)
    ? { op: 'moveClip', clipId: item.id, start }
    : { op: 'updateEffect', effectId: item.id, patch: { start } }
}

// --- трим ------------------------------------------------------------------------------------

/** Трим края элемента до timeline-позиции `edgeTime` (с ограничениями соседей, исходника и 1 кадра). */
export function planTrim(p: Project, itemId: string, edge: TrimEdge, edgeTime: number): EditOp | null {
  const ref = findItem(p, itemId)
  if (!ref || ref.track.locked) return null
  const { track, item, index } = ref
  const prev = track.items[index - 1]
  const next = track.items[index + 1]
  const limits = {
    min: prev ? itemEnd(prev) : 0,
    max: next ? next.start : Infinity,
    minDuration: 1 / p.fps,
    fps: p.fps,
  }
  if (isClip(item)) {
    const asset = p.assets.find((a) => a.id === item.assetId)
    const patch = trimClipData(item, asset, edge, edgeTime, limits)
    const same =
      Math.abs(patch.start - item.start) < 1e-9 &&
      Math.abs(patch.duration - item.duration) < 1e-9 &&
      Math.abs(patch.sourceIn - item.sourceIn) < 1e-9 &&
      Math.abs(patch.sourceOut - item.sourceOut) < 1e-9
    return same ? null : { op: 'updateClip', clipId: item.id, patch }
  }
  const end = itemEnd(item)
  let start = item.start
  let duration: number
  if (edge === 'start') {
    start = Math.min(Math.max(edgeTime, limits.min), end - limits.minDuration)
    duration = end - start
  } else {
    duration = Math.max(Math.min(edgeTime, limits.max), item.start + limits.minDuration) - item.start
  }
  if (Math.abs(start - item.start) < 1e-9 && Math.abs(duration - item.duration) < 1e-9) return null
  return { op: 'updateEffect', effectId: item.id, patch: { start, duration } }
}

// --- ассет на таймлайн -----------------------------------------------------------------------

export interface DropTarget {
  start: number
  /** Дорожка под курсором (если подходит и свободна — клип ляжет на неё). */
  trackId?: string
}

/** Подходящая дорожка для ассета: предпочтительная → любая свободная того же типа → null (нужна новая). */
export function pickTrackForAsset(p: Project, asset: Asset, span: Span, preferredId?: string): Track | null {
  const ok = (t: Track) => !t.locked && trackAcceptsAsset(t, asset.kind) && isFree(t, span)
  const preferred = p.tracks.find((t) => t.id === preferredId)
  if (preferred && ok(preferred)) return preferred
  return p.tracks.find(ok) ?? null
}

/** Ops для перетаскивания ассета из Media Bin на таймлайн (при необходимости — с новой дорожкой). */
export function planAssetDrop(p: Project, asset: Asset, target: DropTarget): EditOp[] {
  const clip = clipFromAsset(asset, Math.max(0, target.start), p.fps)
  const span = { start: clip.start, end: clip.start + assetClipDuration(asset, p.fps) }
  const track = pickTrackForAsset(p, asset, span, target.trackId)
  if (track) return [{ op: 'addClip', trackId: track.id, clip }]
  const kind: TrackKind = asset.kind === 'audio' ? 'audio' : 'video'
  return [
    { op: 'addTrack', track: trackInput(p, kind, 'tmp_track'), index: newTrackIndex(p, kind) },
    { op: 'addClip', trackId: 'tmp_track', clip },
  ]
}

// --- копировать / вставить -------------------------------------------------------------------

export interface ClipboardEntry {
  item: TrackItem
  trackId: string
  trackKind: TrackKind
}

export function copyItems(p: Project, ids: readonly string[]): ClipboardEntry[] {
  const res: ClipboardEntry[] = []
  for (const id of ids) {
    const ref = findItem(p, id)
    if (ref) res.push({ item: structuredClone(ref.item), trackId: ref.track.id, trackKind: ref.track.kind })
  }
  return res.sort((a, b) => a.item.start - b.item.start)
}

/** Вставка в позицию плейхеда: на исходные дорожки, если там свободно, иначе на свободные того же типа или новые. */
export function planPaste(p: Project, entries: readonly ClipboardEntry[], at: number): EditOp[] {
  if (entries.length === 0) return []
  const base = Math.min(...entries.map((e) => e.item.start))
  const reserved = new Map<string, Span[]>()
  const newTracks = new Map<TrackKind, string>()
  const ops: EditOp[] = []
  let tmp = 0

  const free = (t: Track, span: Span) =>
    !t.locked && isFree(t, span) && !(reserved.get(t.id) ?? []).some((s) => overlaps(s, span))

  for (const e of entries) {
    const start = Math.max(0, at + (e.item.start - base))
    const span = { start, end: start + e.item.duration }
    const candidates = p.tracks.filter((t) => t.kind === e.trackKind)
    const original = candidates.find((t) => t.id === e.trackId)
    let trackId = original && free(original, span) ? original.id : candidates.find((t) => free(t, span))?.id
    if (!trackId) {
      trackId = newTracks.get(e.trackKind)
      if (!trackId || (reserved.get(trackId) ?? []).some((s) => overlaps(s, span))) {
        // ID новой дорожки — временный, чтобы на него можно было сослаться ниже
        trackId = `tmp_paste_trk_${tmp++}`
        newTracks.set(e.trackKind, trackId)
        ops.push({
          op: 'addTrack',
          track: trackInput(p, e.trackKind, trackId),
          index: newTrackIndex(p, e.trackKind),
        })
      }
    }
    reserved.set(trackId, [...(reserved.get(trackId) ?? []), span])
    ops.push(pasteOp(e.item, start, trackId, () => `tmp_paste_${tmp++}`))
  }
  return ops
}

/** Копия элемента с новой позицией; вложенным маркерам/эффектам — временные ID (настоящие выдаст applyOps). */
function pasteOp(item: TrackItem, start: number, trackId: string, tmpId: () => string): EditOp {
  if (!isClip(item)) {
    const { id: _id, type: _type, ...rest } = item
    return { op: 'addEffect', target: { trackId }, effect: { ...rest, start } }
  }
  const { id: _id, ...rest } = item
  return {
    op: 'addClip',
    trackId,
    clip: {
      ...rest,
      start,
      // anchor внутри копии указывал бы на маркеры оригинала — снимаем
      effects: item.effects.map(({ anchor: _anchor, ...e }): EffectItem => ({ ...e, id: tmpId() })),
      markers: item.markers.map((m) => ({ ...m, id: tmpId() })),
    },
  }
}
