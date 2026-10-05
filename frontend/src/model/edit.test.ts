import { describe, expect, it } from 'vitest'
import type { Clip, Project } from '@/shared/types.gen'
import { findClip, findItem, findTrack } from './lookup'
import { applyOps } from './ops/applyOps'
import { copyItems, planAssetDrop, planDelete, planMove, planPaste, planSplitAt, planTrim } from './edit'
import { audioAsset, sampleProject, seqIds, videoAsset } from './testUtils'
import { displayOrder, moveTrackInDisplay } from './tracks'

const ctx = () => ({
  newId: seqIds(),
  resolveAsset: (id: string) => [videoAsset, audioAsset].find((a) => a.id === id),
})
const apply = (p: Project, ops: Parameters<typeof applyOps>[1]) => applyOps(p, ops, ctx()).project
const clipOf = (p: Project, id: string) => findClip(p, id)!.clip

describe('planSplitAt (Ctrl+K)', () => {
  it('splits selected clips under the playhead, or all clips under it when none selected', () => {
    const p = sampleProject()
    p.tracks[1]!.items = [{ ...clipOf(p, 'clp_a'), id: 'clp_c', start: 0.5 }]
    expect(planSplitAt(p, 1, ['clp_c']).map((o) => o.op === 'splitClip' && o.clipId)).toEqual(['clp_c'])
    expect(planSplitAt(p, 1, []).map((o) => o.op === 'splitClip' && o.clipId)).toEqual(['clp_a', 'clp_c'])
    // на стыке клипов V1 резать нечего — режется только clp_c (0.5..2.5)
    expect(planSplitAt(p, 2, []).map((o) => o.op === 'splitClip' && o.clipId)).toEqual(['clp_c'])
  })

  it('skips locked tracks', () => {
    const p = sampleProject()
    p.tracks[0]!.locked = true
    expect(planSplitAt(p, 1)).toEqual([])
  })
})

describe('planDelete', () => {
  it('ripple delete closes the gap', () => {
    const p = sampleProject()
    const next = apply(p, planDelete(p, ['clp_a'], true))
    expect(clipOf(next, 'clp_b').start).toBe(0)
  })

  it('deletes effects from fx tracks', () => {
    const p = sampleProject()
    const next = apply(p, planDelete(p, ['fx_shake', 'clp_b']))
    expect(findItem(next, 'fx_shake')).toBeUndefined()
    expect(findItem(next, 'clp_b')).toBeUndefined()
  })
})

describe('planMove', () => {
  it('moves to a free spot (also across tracks of the same kind)', () => {
    const p = sampleProject()
    const ops = planMove(p, [{ id: 'clp_b', start: 1, trackId: 'trk_v2' }])!
    const next = apply(p, ops)
    expect(findTrack(next, 'trk_v2')!.items.map((i) => i.id)).toEqual(['clp_b'])
  })

  it('returns null (revert) when the target is occupied without Alt', () => {
    const p = sampleProject()
    expect(planMove(p, [{ id: 'clp_b', start: 1, trackId: 'trk_v1' }])).toBeNull()
  })

  it('ripple-inserts with Alt: items from the insertion point shift right', () => {
    const p = sampleProject()
    p.tracks[1]!.items = [{ ...clipOf(p, 'clp_a'), id: 'clp_c', start: 0 }]
    // clp_c (2 с) вставляется в 1.0 на V1: clp_a (0..2) налезает → сдвигается он и всё после
    const ops = planMove(p, [{ id: 'clp_c', start: 1, trackId: 'trk_v1' }], { rippleInsert: true })!
    const next = apply(p, ops)
    const items = findTrack(next, 'trk_v1')!.items.map((i) => [i.id, i.start])
    expect(items).toEqual([
      ['clp_c', 1],
      ['clp_a', 3],
      ['clp_b', 5],
    ])
  })

  it('rejects incompatible track kinds and locked tracks', () => {
    const p = sampleProject()
    expect(planMove(p, [{ id: 'clp_a', start: 5, trackId: 'trk_a1' }])).toBeNull()
    p.tracks[1]!.locked = true
    expect(planMove(p, [{ id: 'clp_a', start: 5, trackId: 'trk_v2' }])).toBeNull()
  })

  it('moves fx items between fx tracks keeping their id', () => {
    const p = sampleProject()
    p.tracks.push({
      id: 'trk_fx2',
      kind: 'fx',
      name: 'FX2',
      muted: false,
      locked: false,
      hidden: false,
      items: [],
    })
    const next = apply(p, planMove(p, [{ id: 'fx_shake', start: 3, trackId: 'trk_fx2' }])!)
    expect(findItem(next, 'fx_shake')!.track.id).toBe('trk_fx2')
    expect(findItem(next, 'fx_shake')!.item.start).toBe(3)
  })
})

describe('planTrim', () => {
  it('trims start: sourceIn follows, limited by previous clip and by sourceIn ≥ 0', () => {
    const p = sampleProject()
    // clp_b: start 2, source 3..5. Тянем начало влево до 1 — упирается в clp_a (конец 2)
    expect(planTrim(p, 'clp_b', 'start', 1)).toBeNull()
    const shrink = apply(p, [planTrim(p, 'clp_b', 'start', 2.5)!])
    expect(clipOf(shrink, 'clp_b')).toMatchObject({ start: 2.5, duration: 1.5, sourceIn: 3.5, sourceOut: 5 })
    // освобождаем место слева: исходник позволяет протянуть начало на 3 с (sourceIn 3 → 0)
    const p2 = apply(p, [{ op: 'removeClip', clipId: 'clp_a' }])
    const ext = apply(p2, [planTrim(p2, 'clp_b', 'start', -10)!])
    expect(clipOf(ext, 'clp_b')).toMatchObject({ start: 0, sourceIn: 1 })
  })

  it('trims end within the asset duration', () => {
    const p = sampleProject()
    const next = apply(p, [planTrim(p, 'clp_b', 'end', 100)!])
    // ассет 10 с, sourceOut 5 → максимум +5 с
    expect(clipOf(next, 'clp_b')).toMatchObject({ duration: 7, sourceOut: 10 })
  })

  it('reverse clip: trimming the timeline start cuts the end of the source range', () => {
    const p = sampleProject()
    const b = p.tracks[0]!.items[1] as Clip
    b.reverse = true
    const next = apply(p, [planTrim(p, 'clp_b', 'start', 3)!])
    expect(clipOf(next, 'clp_b')).toMatchObject({ start: 3, duration: 1, sourceIn: 3, sourceOut: 4 })
  })

  it('keeps at least one frame', () => {
    const p = sampleProject()
    const next = apply(p, [planTrim(p, 'clp_b', 'end', 0)!])
    expect(clipOf(next, 'clp_b').duration).toBeCloseTo(1 / 30, 9)
  })
})

describe('planAssetDrop', () => {
  it('drops onto the hovered compatible track', () => {
    const p = sampleProject()
    const next = apply(p, planAssetDrop(p, videoAsset, { start: 0, trackId: 'trk_v2' }))
    expect(findTrack(next, 'trk_v2')!.items).toHaveLength(1)
  })

  it('falls back to a free track of the right kind, or creates a new one', () => {
    const p = sampleProject()
    const audio = apply(p, planAssetDrop(p, audioAsset, { start: 0, trackId: 'trk_v1' }))
    expect(findTrack(audio, 'trk_a1')!.items).toHaveLength(1)
    const p2 = sampleProject()
    p2.tracks = p2.tracks.filter((t) => t.id !== 'trk_v2')
    const next = apply(p2, planAssetDrop(p2, videoAsset, { start: 1, trackId: 'trk_v1' }))
    expect(next.tracks).toHaveLength(p2.tracks.length + 1)
    // новая видеодорожка — поверх визуальных
    expect(displayOrder(next)[0]!.items[0]!.start).toBe(1)
  })
})

describe('copy / paste', () => {
  it('pastes at the playhead onto the original track when free, otherwise onto a new one', () => {
    const p = sampleProject()
    const clip = copyItems(p, ['clp_a'])
    const next = apply(p, planPaste(p, clip, 4))
    const v1 = findTrack(next, 'trk_v1')!.items
    expect(v1.map((i) => i.start)).toEqual([0, 2, 4])
    expect(v1[2]!.id).not.toBe('clp_a')
    // на занятое место — на свободную V2
    const again = apply(p, planPaste(p, clip, 1))
    expect(findTrack(again, 'trk_v2')!.items.map((i) => i.start)).toEqual([1])
  })
})

describe('track reorder', () => {
  it('moves tracks within their display group', () => {
    const p = sampleProject()
    // экран: FX, V2, V1 | A1
    expect(displayOrder(p).map((t) => t.id)).toEqual(['trk_fx', 'trk_v2', 'trk_v1', 'trk_a1'])
    moveTrackInDisplay(p, 'trk_v1', 0)
    expect(displayOrder(p).map((t) => t.id)).toEqual(['trk_v1', 'trk_fx', 'trk_v2', 'trk_a1'])
    // V1 теперь верхний слой → последний среди визуальных в массиве
    expect(p.tracks.map((t) => t.id)).toEqual(['trk_v2', 'trk_fx', 'trk_v1', 'trk_a1'])
    // аудио не уходит в визуальную группу
    expect(moveTrackInDisplay(p, 'trk_a1', 0)).toBe(false)
  })
})
