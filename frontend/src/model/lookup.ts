// Поиск сущностей проекта по ID. Работает и с Immer-драфтами (возвращает ссылки внутрь).
import type { Clip, EffectItem, Marker, Project, Track, TrackItem } from '@/shared/types.gen'

export function isClip(item: TrackItem): item is Clip {
  return item.type === 'clip'
}

export function isEffect(item: TrackItem): item is EffectItem {
  return item.type === 'effect'
}

export function findTrack(p: Project, trackId: string): Track | undefined {
  return p.tracks.find((t) => t.id === trackId)
}

export interface ItemRef {
  track: Track
  item: TrackItem
  index: number
}

export function findItem(p: Project, itemId: string): ItemRef | undefined {
  for (const track of p.tracks) {
    const index = track.items.findIndex((i) => i.id === itemId)
    if (index >= 0) return { track, item: track.items[index]!, index }
  }
  return undefined
}

export function findClip(
  p: Project,
  clipId: string,
): { track: Track; clip: Clip; index: number } | undefined {
  const ref = findItem(p, clipId)
  if (!ref || !isClip(ref.item)) return undefined
  return { track: ref.track, clip: ref.item, index: ref.index }
}

export interface EffectRef {
  effect: EffectItem
  list: EffectItem[] | TrackItem[]
  index: number
  track: Track
  clip?: Clip
}

export function findEffect(p: Project, effectId: string): EffectRef | undefined {
  for (const track of p.tracks) {
    for (let i = 0; i < track.items.length; i++) {
      const item = track.items[i]!
      if (item.id === effectId && isEffect(item)) return { effect: item, list: track.items, index: i, track }
      if (isClip(item)) {
        const j = item.effects.findIndex((e) => e.id === effectId)
        if (j >= 0) return { effect: item.effects[j]!, list: item.effects, index: j, track, clip: item }
      }
    }
  }
  return undefined
}

export interface MarkerRef {
  marker: Marker
  list: Marker[]
  index: number
  clip?: Clip
}

export function findMarker(p: Project, markerId: string): MarkerRef | undefined {
  const pi = p.markers.findIndex((m) => m.id === markerId)
  if (pi >= 0) return { marker: p.markers[pi]!, list: p.markers, index: pi }
  for (const clip of allClips(p)) {
    const i = clip.markers.findIndex((m) => m.id === markerId)
    if (i >= 0) return { marker: clip.markers[i]!, list: clip.markers, index: i, clip }
  }
  return undefined
}

export function* allClips(p: Project): Generator<Clip> {
  for (const t of p.tracks) for (const i of t.items) if (isClip(i)) yield i
}

export function* allEffects(p: Project): Generator<EffectItem> {
  for (const t of p.tracks) {
    for (const i of t.items) {
      if (isEffect(i)) yield i
      else yield* i.effects
    }
  }
}

/** Все ID проекта (для проверки уникальности). */
export function collectIds(p: Project): Set<string> {
  const ids = new Set<string>()
  for (const t of p.tracks) {
    ids.add(t.id)
    for (const i of t.items) {
      ids.add(i.id)
      if (isClip(i)) {
        for (const e of i.effects) ids.add(e.id)
        for (const m of i.markers) ids.add(m.id)
      }
    }
  }
  for (const m of p.markers) ids.add(m.id)
  for (const s of p.sections) ids.add(s.id)
  return ids
}

/** Тип элементов, допустимых на дорожке. */
export function trackAcceptsAsset(track: Track, assetKind: 'video' | 'audio' | 'image'): boolean {
  if (track.kind === 'fx') return false
  return track.kind === 'audio' ? assetKind === 'audio' : assetKind !== 'audio'
}
