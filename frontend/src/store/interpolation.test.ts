import { beforeEach, describe, expect, it } from 'vitest'
import { fixtures } from '@/api/mocks/fixtures'
import { findClip } from '@/model/lookup'
import { clipFromAsset } from '@/model/project'
import { sampleProject } from '@/model/testUtils'
import { findRampPreset } from '@/shared/rampPresets'
import type { Asset, Clip, Project } from '@/shared/types.gen'
import { useAssets } from './assets'
import { scanInterpolations, useInterpolation } from './interpolation'
import { useProject } from './project'

const VIDEO = fixtures.assets.find((a) => a.kind === 'video' && a.fps === 30)!

function load(): void {
  const p: Project = sampleProject()
  p.assets = [structuredClone(VIDEO)]
  const base = clipFromAsset(VIDEO, 0, p.fps)
  const clip: Clip = {
    ...base,
    id: 'clp_slow',
    start: 0,
    duration: 4,
    sourceIn: 2,
    sourceOut: 4,
    timeRemap: structuredClone(findRampPreset('fast-slow-fast')!.timeRemap),
  }
  p.tracks = [{ ...p.tracks[0]!, items: [clip] }]
  useProject.getState().load(p)
  useInterpolation.setState({ byClip: {} })
  useAssets.setState({ assets: {}, order: [], jobs: {} })
}

const clip = (): Clip => findClip(useProject.getState().project, 'clp_slow')!.clip

async function until<T>(fn: () => T | null | undefined, timeout = 9000): Promise<T> {
  const end = Date.now() + timeout
  for (;;) {
    const v = fn()
    if (v !== null && v !== undefined) return v
    if (Date.now() > end) throw new Error('timeout')
    await new Promise((r) => setTimeout(r, 50))
  }
}

describe('interpolation store (CONTRACT §5.3)', () => {
  beforeEach(load)

  it('requests interpolation for a slow ramp and sets interpolatedAssetId outside history', async () => {
    scanInterpolations()
    const running = useInterpolation.getState().byClip['clp_slow']
    expect(running).toMatchObject({ status: 'running' })
    expect(running!.key).toMatch(/\|16$/)
    const id = await until(() => clip().interpolatedAssetId)
    const derived: Asset | undefined = useAssets.getState().assets[id]
    expect(derived?.parent).toMatchObject({ assetId: VIDEO.id, factor: 16, quality: 'rife' })
    expect(derived!.parent!.sourceIn).toBeCloseTo(1.9, 9)
    expect(derived!.parent!.sourceOut).toBeCloseTo(4.1, 9)
    expect(useInterpolation.getState().byClip['clp_slow']).toBeUndefined()
    expect(useProject.getState().history.past).toHaveLength(0)

    scanInterpolations()
    expect(useInterpolation.getState().byClip['clp_slow']).toBeUndefined()

    useProject.getState().dispatch([{ op: 'setTimeRemap', clipId: 'clp_slow', timeRemap: null }])
    useProject
      .getState()
      .dispatch([{ op: 'updateClip', clipId: 'clp_slow', patch: { speed: 1, duration: 2 } }])
    scanInterpolations()
    expect(clip().interpolatedAssetId).toBeUndefined()
    expect(useInterpolation.getState().byClip['clp_slow']).toBeUndefined()
  }, 15000)

  it('re-requests when the clip leaves the covered range', async () => {
    scanInterpolations()
    const first = await until(() => clip().interpolatedAssetId)
    useProject
      .getState()
      .dispatch([{ op: 'updateClip', clipId: 'clp_slow', patch: { sourceIn: 6, sourceOut: 8 } }])
    scanInterpolations()
    expect(clip().interpolatedAssetId).toBeUndefined()
    expect(useInterpolation.getState().byClip['clp_slow']?.status).toBe('running')
    const second = await until(() => clip().interpolatedAssetId)
    expect(second).not.toBe(first)
  }, 15000)
})
