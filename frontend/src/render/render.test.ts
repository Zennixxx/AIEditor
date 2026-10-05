import { describe, expect, it } from 'vitest'
import { applyOps } from '@/model/ops/applyOps'
import { findTrack } from '@/model/lookup'
import { musicProject, sampleProject, seqIds } from '@/model/testUtils'
import { effectsRegistry } from '@/shared/effects-registry'
import type { Clip, EffectItem, Project } from '@/shared/types.gen'
import { shakeOffset } from './effects/camera'
import { EFFECT_MODULES, effectStages } from './effects'
import { flickerLevel } from './effects/light'
import { transitionTravel, zoomTransitionScale } from './effects/transition'
import { buildFramePlan, effectPass, type LayerStep } from './framePlan'
import { parseColor } from './gl'
import { applyUvMatrix, IDENTITY_TRANSFORM, layerUvMatrix } from './layerMath'
import { effectSeed, hash32, valueNoise } from './noise'

describe('layerUvMatrix (CONTRACT §1)', () => {
  const near = (a: [number, number], b: [number, number]) => {
    expect(a[0]).toBeCloseTo(b[0], 6)
    expect(a[1]).toBeCloseTo(b[1], 6)
  }

  it('identity cover: same aspect maps corners to corners', () => {
    const m = layerUvMatrix(1920, 1080, 1280, 720, IDENTITY_TRANSFORM)
    near(applyUvMatrix(m, 0, 0), [0, 0])
    near(applyUvMatrix(m, 1920, 1080), [1, 1])
    near(applyUvMatrix(m, 960, 540), [0.5, 0.5])
  })

  it('cover crops the wider source by the center', () => {
    // источник 2:1 в кадр 1:1 — видна средняя половина по ширине
    const m = layerUvMatrix(100, 100, 200, 100, IDENTITY_TRANSFORM)
    near(applyUvMatrix(m, 0, 50), [0.25, 0.5])
    near(applyUvMatrix(m, 100, 50), [0.75, 0.5])
  })

  it('position: x = 1 moves the layer center to the right edge, y = 1 — to the bottom', () => {
    const m = layerUvMatrix(100, 100, 100, 100, { ...IDENTITY_TRANSFORM, x: 1, y: 1 })
    near(applyUvMatrix(m, 100, 100), [0.5, 0.5])
  })

  it('scale 2 shows the middle half', () => {
    const m = layerUvMatrix(100, 100, 100, 100, { ...IDENTITY_TRANSFORM, scale: 2 })
    near(applyUvMatrix(m, 0, 0), [0.25, 0.25])
    near(applyUvMatrix(m, 100, 100), [0.75, 0.75])
  })

  it('rotation is clockwise with y down', () => {
    // поворот на 90° по часовой: верх слоя уходит вправо → правая середина кадра показывает верх слоя
    const m = layerUvMatrix(100, 100, 100, 100, { ...IDENTITY_TRANSFORM, rotation: 90 })
    near(applyUvMatrix(m, 100, 50), [0.5, 0])
  })

  it('anchor is a pivot and does not move the layer by itself', () => {
    const t = { ...IDENTITY_TRANSFORM, anchorX: 1, anchorY: 1 }
    near(applyUvMatrix(layerUvMatrix(100, 100, 100, 100, t), 30, 70), [0.3, 0.7])
    // масштаб вокруг правого нижнего угла: угол остаётся на месте
    const m = layerUvMatrix(100, 100, 100, 100, { ...t, scale: 2 })
    near(applyUvMatrix(m, 100, 100), [1, 1])
    near(applyUvMatrix(m, 0, 0), [0.5, 0.5])
  })
})

describe('noise', () => {
  it('is deterministic and bounded', () => {
    expect(hash32('fx_abc')).toBe(hash32('fx_abc'))
    expect(hash32('fx_abc')).not.toBe(hash32('fx_abd'))
    expect(effectSeed('fx_abc')).toBeGreaterThanOrEqual(0)
    expect(effectSeed('fx_abc')).toBeLessThan(1)
    for (let x = 0; x < 20; x += 0.37) {
      const v = valueNoise(42, x)
      expect(Math.abs(v)).toBeLessThanOrEqual(1)
      expect(valueNoise(42, x)).toBe(v)
    }
  })

  it('value noise is continuous', () => {
    expect(Math.abs(valueNoise(7, 3.999) - valueNoise(7, 4.001))).toBeLessThan(0.01)
  })
})

describe('effect helpers', () => {
  it('shake offset scales with intensity and is zero at zero intensity', () => {
    expect(shakeOffset(0.3, 0.1, 12, 40, 3, 0).map(Math.abs)).toEqual([0, 0, 0])
    const a = shakeOffset(0.3, 0.1, 12, 40, 3, 1)
    const b = shakeOffset(0.3, 0.1, 12, 40, 3, 0.5)
    expect(b[0]).toBeCloseTo(a[0] / 2)
    expect(Math.abs(a[0])).toBeLessThanOrEqual(40)
  })

  it('flicker: square wave without randomness', () => {
    expect(flickerLevel(0.1, 0, 10, 0)).toBe(1)
    expect(flickerLevel(0.1, 0.15, 10, 0)).toBe(0)
    const r = flickerLevel(0.1, 0.15, 10, 1)
    expect(r).toBeGreaterThanOrEqual(0)
    expect(r).toBeLessThanOrEqual(1)
  })

  it('parseColor', () => {
    expect(parseColor('#ff0000')).toEqual([1, 0, 0, 1])
    expect(parseColor('#00000080')[3]).toBeCloseTo(128 / 255)
    expect(parseColor('nope')).toEqual([0, 0, 0, 1])
  })

  it('every registry effect has a shader module', () => {
    const missing = effectsRegistry.effects.filter((e) => !EFFECT_MODULES.has(e.id)).map((e) => e.id)
    expect(missing).toEqual([])
    for (const id of EFFECT_MODULES.keys())
      expect(effectsRegistry.effects.some((e) => e.id === id)).toBe(true)
  })

  it('glow is multi-pass, single-pass modules expose one stage', () => {
    expect(effectStages(EFFECT_MODULES.get('glow')!)).toHaveLength(3)
    expect(effectStages(EFFECT_MODULES.get('shake')!)).toHaveLength(1)
  })

  it('transition travel: still at the edges, a whole-frame jump at the cut', () => {
    expect(transitionTravel(0)).toBe(0)
    expect(transitionTravel(1)).toBeCloseTo(0, 9)
    expect(transitionTravel(0.4999)).toBeCloseTo(0.5, 3)
    expect(transitionTravel(0.5)).toBeCloseTo(-0.5, 6)
    // до стыка ускоряется, после — замедляется
    expect(transitionTravel(0.25)).toBeLessThan(0.25)
    expect(transitionTravel(0.75)).toBeGreaterThan(-0.25)
    expect(zoomTransitionScale(0, 2)).toBe(1)
    expect(zoomTransitionScale(0.5, 2)).toBe(2)
    expect(zoomTransitionScale(1, 3)).toBe(1)
  })
})

describe('buildFramePlan', () => {
  it('layers bottom-to-top with fx tracks as adjustment steps', () => {
    const p = sampleProject()
    const plan = buildFramePlan(p, 1.2)
    expect(plan.frame).toBe(36)
    expect(plan.steps.map((s) => s.kind)).toEqual(['layer', 'adjust'])
    const layer = plan.steps[0] as LayerStep
    expect(layer.clip.id).toBe('clp_a')
    expect(layer.local).toBeCloseTo(1.2)
    expect(layer.src).toBeCloseTo(1.2)
    expect(layer.transform).toEqual(IDENTITY_TRANSFORM)
    expect(plan.steps[1]!.kind === 'adjust' && plan.steps[1]!.effects[0]!.item.id).toBe('fx_shake')
  })

  it('skips hidden tracks, inactive effects and zero opacity', () => {
    const p = structuredClone(sampleProject())
    expect(buildFramePlan(p, 1.6).steps.map((s) => s.kind)).toEqual(['layer']) // fx 1..1.5 закончился
    findTrack(p, 'trk_fx')!.hidden = true
    expect(buildFramePlan(p, 1.2).steps.map((s) => s.kind)).toEqual(['layer'])
    ;(findTrack(p, 'trk_v1')!.items[0] as Clip).opacity = 0
    expect(buildFramePlan(p, 1.2).steps).toEqual([])
  })

  it('evaluates keyframed transform and clip effects relative to the clip', () => {
    const p = structuredClone(sampleProject())
    const c = findTrack(p, 'trk_v1')!.items[1] as Clip // 2..4
    c.transform.scale = [
      { t: 0, v: 1, ease: 'linear' },
      { t: 2, v: 2, ease: 'linear' },
    ]
    c.effects.push({
      id: 'fx_inclip',
      type: 'effect',
      effect: 'flash',
      start: 0.5,
      duration: 0.5,
      params: { strength: 2 },
      envelope: { attack: 0, hold: 0.5, decay: 0, curve: 'linear' },
      enabled: true,
    })
    const step = buildFramePlan(p, 2.7).steps[0] as LayerStep
    expect(step.clip.id).toBe('clp_b')
    expect(step.transform.scale).toBeCloseTo(1.35)
    expect(step.effects).toHaveLength(1)
    expect(step.effects[0]!.intensity).toBe(2)
    expect(step.effects[0]!.params).toMatchObject({ strength: 2, color: '#ffffff', opacity: 0.9 })
  })

  it('applyEffectToMarkers result is visible in the plan on every marker', () => {
    let p: Project = musicProject()
    p = applyOps(
      p,
      [
        {
          op: 'addMarkers',
          target: { clipId: 'clp_music' },
          markers: [0, 1, 2].map((i) => ({ t: 20 + i, kind: 'bass' as const, strength: 1 })),
        },
        { op: 'applyEffectToMarkers', effect: 'shake', filter: {}, target: 'newFxTrack' },
      ],
      { newId: seqIds() },
    ).project
    for (const t of [10, 11.1, 12.2]) {
      const adjust = buildFramePlan(p, t).steps.find((s) => s.kind === 'adjust')
      expect(adjust?.effects[0]?.item.effect).toBe('shake')
    }
    expect(buildFramePlan(p, 10.5).steps.some((s) => s.kind === 'adjust')).toBe(false)
  })

  it('effectPass: disabled and out-of-range effects are skipped', () => {
    const fx = findTrack(sampleProject(), 'trk_fx')!.items[0] as EffectItem
    expect(effectPass(fx, 0.1)).not.toBeNull()
    expect(effectPass({ ...fx, enabled: false }, 0.1)).toBeNull()
    expect(effectPass(fx, -0.1)).toBeNull()
    expect(effectPass(fx, 0.5)).toBeNull()
  })
})
