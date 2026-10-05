// Создание проекта и «нормализация» после каждой транзакции.
import type { Asset, ClipInput, Project, Track, TrackInput, TrackKind } from '@/shared/types.gen'
import { newId } from '@/shared/ids'
import { snapToFrame } from '@/shared/time'
import { itemEnd } from './clipTime'
import { isClip } from './lookup'

export const DEFAULT_IMAGE_DURATION = 5

export function createEmptyProject(
  opts: Partial<Pick<Project, 'name' | 'fps' | 'width' | 'height'>> = {},
): Project {
  const now = new Date().toISOString()
  return {
    schemaVersion: 1,
    id: newId('prj'),
    name: opts.name ?? 'Без названия',
    fps: opts.fps ?? 30,
    width: opts.width ?? 1920,
    height: opts.height ?? 1080,
    duration: 0,
    background: '#000000',
    assets: [],
    tracks: [newTrack('video', 'V1'), newTrack('audio', 'A1')],
    markers: [],
    sections: [],
    createdAt: now,
    updatedAt: now,
    revision: 0,
  }
}

export function newTrack(kind: TrackKind, name: string, id = newId('trk')): Track {
  const t: Track = { id, kind, name, muted: false, locked: false, hidden: false, items: [] }
  if (kind === 'audio') t.volume = 1
  return t
}

/** Описание новой дорожки для op addTrack. Имя — следующее свободное (V2, A3, FX1…). */
export function trackInput(p: Project, kind: TrackKind, id?: string): TrackInput {
  const prefix = kind === 'video' ? 'V' : kind === 'audio' ? 'A' : 'FX'
  const names = new Set(p.tracks.map((t) => t.name))
  let n = p.tracks.filter((t) => t.kind === kind).length + 1
  while (names.has(`${prefix}${n}`)) n++
  const t: TrackInput = { kind, name: `${prefix}${n}`, muted: false, locked: false, hidden: false }
  if (id) t.id = id
  if (kind === 'audio') t.volume = 1
  return t
}

/** Длительность клипа на таймлайне для ассета целиком, квантованная вниз к кадру. */
export function assetClipDuration(asset: Asset, fps: number): number {
  if (asset.kind === 'image' || !(asset.duration > 0)) return DEFAULT_IMAGE_DURATION
  const frames = Math.floor(asset.duration * fps + 1e-6)
  return Math.max(1, frames) / fps
}

/** Клип, покрывающий ассет целиком, начиная с `start` (timeline time). */
export function clipFromAsset(asset: Asset, start: number, fps: number): ClipInput {
  const duration = assetClipDuration(asset, fps)
  const clip: ClipInput = {
    type: 'clip',
    assetId: asset.id,
    start: snapToFrame(start, fps),
    duration,
    sourceIn: 0,
    sourceOut: duration,
    speed: 1,
    reverse: false,
    transform: { x: 0, y: 0, scale: 1, rotation: 0, anchorX: 0, anchorY: 0 },
    opacity: 1,
    blendMode: 'normal',
    effects: [],
    markers: [],
  }
  if (asset.hasAudio) clip.volume = 1
  return clip
}

/** Нормализация после транзакции: сортировка элементов, снятие «висячих» anchor, длительность композиции. */
export function finalizeProject(p: Project): void {
  const markerIds = new Set(p.markers.map((m) => m.id))
  const clipIds = new Set<string>()
  let end = 0
  for (const t of p.tracks) {
    t.items.sort((a, b) => a.start - b.start)
    for (const item of t.items) {
      end = Math.max(end, itemEnd(item))
      if (isClip(item)) {
        clipIds.add(item.id)
        for (const m of item.markers) markerIds.add(m.id)
      }
    }
  }
  // CONTRACT §2 инвариант 6: маркер удалён → anchor снимается, эффект остаётся на месте
  for (const t of p.tracks) {
    for (const item of t.items) {
      const effects = isClip(item) ? item.effects : [item]
      for (const e of effects) {
        if (!e.anchor) continue
        if (!markerIds.has(e.anchor.markerId) || (e.anchor.clipId && !clipIds.has(e.anchor.clipId)))
          delete e.anchor
      }
    }
  }
  if (Math.abs(p.duration - end) > 1e-9) p.duration = end
}
