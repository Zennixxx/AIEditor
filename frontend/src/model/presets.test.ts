import { describe, expect, it } from 'vitest'
import type { EffectItem, EffectPreset } from '@/shared/types.gen'
import { findClip, findTrack } from './lookup'
import { applyOps } from './ops/applyOps'
import { planPresetDrop, presetEffectsFromSelection, presetSpan, selectionHasEffects } from './presets'
import { sampleProject, seqIds } from './testUtils'

const round = (v: number) => Math.round(v * 1e6) / 1e6

const env = { attack: 0, hold: 0.05, decay: 0.2, curve: 'exp' as const }

const hit: EffectPreset = {
  id: 'pst_test',
  name: 'Удар',
  effects: [
    { effect: 'shake', start: 0, duration: 0.4, params: { amount: 60 }, envelope: env },
    { effect: 'flash', start: 0, duration: 0.2, params: {}, envelope: env },
    { effect: 'rgbSplit', start: 0.5, duration: 0.2, params: {}, envelope: env },
  ],
}

describe('effect presets (FRONTEND.md §4.2)', () => {
  it('collects selected fx items and clip effects relative to the earliest', () => {
    const p = sampleProject()
    findClip(p, 'clp_b')!.clip.effects.push({
      id: 'fx_clip1',
      type: 'effect',
      effect: 'zoomPunch',
      start: 0.25,
      duration: 0.3,
      params: { amount: 1.2 },
      envelope: env,
      enabled: true,
    })
    const effects = presetEffectsFromSelection(p, ['fx_shake', 'clp_b'])
    expect(effects.map((e) => [e.effect, e.start, e.duration])).toEqual([
      ['shake', 0, 0.5],
      ['zoomPunch', 1.25, 0.3],
    ])
    expect(effects[1]!.params).toEqual({ amount: 1.2 })
    expect(selectionHasEffects(p, ['clp_a'])).toBe(false)
    expect(selectionHasEffects(p, ['clp_a'], 'fx_clip1')).toBe(true)
    expect(presetEffectsFromSelection(p, ['clp_a'], 'fx_clip1').map((e) => e.start)).toEqual([0])
  })

  it('drop on a clip: effects into clip.effects, cut at the clip end', () => {
    const p = sampleProject()
    const ops = planPresetDrop(p, hit, { clipId: 'clp_a' }, 1.6)
    const c = findClip(applyOps(p, ops, { newId: seqIds() }).project, 'clp_a')!.clip
    // rgbSplit (1.6 + 0.5 = 2.1) за концом клипа (2 с) — не кладётся
    expect(c.effects.map((e) => [e.effect, round(e.start), round(e.duration)])).toEqual([
      ['shake', 1.6, 0.4],
      ['flash', 1.6, 0.2],
    ])
    expect(c.effects[0]!.params).toEqual({ amount: 60 })
  })

  it('drop on fx tracks: overlapping effects go to new layers', () => {
    const p = sampleProject()
    expect(presetSpan(hit)).toBeCloseTo(0.7)
    const ops = planPresetDrop(p, hit, { trackId: 'trk_fx' }, 2)
    const res = applyOps(p, ops, { newId: seqIds() }).project
    const fx = findTrack(res, 'trk_fx')!.items as EffectItem[]
    // слой 0 — выбранная дорожка: shake 2..2.4 и rgbSplit 2.5..2.7 (fx_shake 1..1.5 не мешает)
    expect(fx.map((e) => e.effect)).toEqual(['shake', 'shake', 'rgbSplit'])
    const extra = res.tracks.filter((t) => t.name === 'FX: Удар')
    expect(extra).toHaveLength(1)
    expect((extra[0]!.items as EffectItem[]).map((e) => e.effect)).toEqual(['flash'])
  })

  it('effects that collide with the fx track items go to new tracks', () => {
    const p = sampleProject()
    const ops = planPresetDrop(p, hit, { trackId: 'trk_fx' }, 1.2)
    const res = applyOps(p, ops, { newId: seqIds() }).project
    // shake 1.2..1.6 и flash 1.2..1.4 пересекают fx_shake (1..1.5), rgbSplit 1.7..1.9 — помещается
    expect((findTrack(res, 'trk_fx')!.items as EffectItem[]).map((e) => e.effect)).toEqual([
      'shake',
      'rgbSplit',
    ])
    expect(res.tracks.filter((t) => t.name === 'FX: Удар')).toHaveLength(2)
  })
})
