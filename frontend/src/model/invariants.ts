// Инварианты проекта — CONTRACT §2 «Инварианты (проверяют обе стороны)».
import type { Project } from '@/shared/types.gen'
import { EPS, effectiveSourceOut, itemEnd } from './clipTime'
import { isClip } from './lookup'
import { sectionListError } from './sections'

export interface Violation {
  code: string
  message: string
}

export function checkInvariants(p: Project): Violation[] {
  const out: Violation[] = []
  const v = (code: string, message: string) => out.push({ code, message })
  const assets = new Map(p.assets.map((a) => [a.id, a]))
  const ids = new Set<string>()
  const markerIds = new Set<string>()
  const clipIds = new Set<string>()
  const unique = (id: string) => {
    if (ids.has(id)) v('duplicate_id', `ID ${id} встречается дважды`)
    ids.add(id)
  }

  for (const m of p.markers) {
    unique(m.id)
    markerIds.add(m.id)
  }
  for (const s of p.sections) unique(s.id)
  // 8. секции списка отсортированы, start < end, не перекрываются
  const sectionList = (owner: string, list: readonly { start: number; end: number }[]) => {
    const err = sectionListError(list)
    if (err) v('bad_sections', `${owner}: ${err}`)
  }
  sectionList('project.sections', p.sections)

  for (const track of p.tracks) {
    unique(track.id)
    let prevEnd = -Infinity
    let prevStart = -Infinity
    for (const item of track.items) {
      unique(item.id)
      // 1. сортировка и отсутствие перекрытий
      if (item.start < prevStart) v('unsorted', `Дорожка ${track.id}: элементы не отсортированы по start`)
      if (item.start < prevEnd - EPS)
        v('overlap', `Дорожка ${track.id}: ${item.id} перекрывает предыдущий элемент`)
      prevStart = item.start
      prevEnd = Math.max(prevEnd, itemEnd(item))
      if (item.start < -EPS) v('negative_start', `${item.id}: start < 0`)
      if (!(item.duration > 0)) v('bad_duration', `${item.id}: duration должна быть > 0`)

      // 2. тип элементов дорожки
      if ((track.kind === 'fx') !== (item.type === 'effect')) {
        v('wrong_item_type', `Дорожка ${track.kind} ${track.id} не может содержать ${item.type} ${item.id}`)
      }
      if (!isClip(item)) continue
      clipIds.add(item.id)
      for (const e of item.effects) unique(e.id)
      for (const m of item.markers) {
        unique(m.id)
        markerIds.add(m.id)
      }
      if (item.sections) {
        for (const s of item.sections) unique(s.id)
        sectionList(`${item.id}.sections`, item.sections)
      }

      // 5. ссылка на ассет
      const asset = assets.get(item.assetId)
      if (!asset) {
        v('asset_missing', `${item.id}: ассет ${item.assetId} отсутствует в project.assets`)
        continue
      }
      if (track.kind === 'audio' ? asset.kind !== 'audio' : asset.kind === 'audio') {
        v('wrong_asset_kind', `${item.id}: ассет ${asset.kind} на дорожке ${track.kind}`)
      }
      if (!(item.speed > 0)) v('bad_speed', `${item.id}: speed должна быть > 0`)

      // 3. 0 ≤ sourceIn < sourceOut ≤ asset.duration (у image длительности нет)
      const out = effectiveSourceOut(item)
      if (item.sourceIn < -EPS || !(item.sourceIn < out)) {
        v('bad_source_range', `${item.id}: нарушено 0 ≤ sourceIn < sourceOut`)
      }
      if (asset.kind !== 'image' && out > asset.duration + EPS) {
        v('source_out_of_asset', `${item.id}: sourceOut ${out} > длительности ассета ${asset.duration}`)
      }
      // 4. без timeRemap: duration = (sourceOut − sourceIn) / speed
      if (!item.timeRemap) {
        const expected = (item.sourceOut - item.sourceIn) / item.speed
        if (Math.abs(expected - item.duration) > 1e-6) {
          v(
            'duration_mismatch',
            `${item.id}: duration ${item.duration} ≠ (sourceOut − sourceIn) / speed = ${expected}`,
          )
        }
      }
    }
  }

  // 6. anchor ссылается на существующий маркер
  for (const track of p.tracks) {
    for (const item of track.items) {
      const effects = isClip(item) ? item.effects : [item]
      for (const e of effects) {
        if (!e.anchor) continue
        if (!markerIds.has(e.anchor.markerId))
          v('dangling_anchor', `${e.id}: маркер ${e.anchor.markerId} не найден`)
        if (e.anchor.clipId && !clipIds.has(e.anchor.clipId)) {
          v('dangling_anchor', `${e.id}: клип ${e.anchor.clipId} не найден`)
        }
      }
    }
  }
  return out
}
