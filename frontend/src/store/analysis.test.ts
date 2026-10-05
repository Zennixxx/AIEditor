import { beforeEach, describe, expect, it } from 'vitest'
import { fixtures } from '@/api/mocks/fixtures'
import { findClip } from '@/model/lookup'
import { musicProject, audioAsset } from '@/model/testUtils'
import type { Clip, Project } from '@/shared/types.gen'
import { autoAnalyzeClips, useAnalysis } from './analysis'
import { canUndo, useProject } from './project'

const ASSET_ID = fixtures.musicAnalysis.assetId // этот ассет мок считает уже проанализированным

function load(): Project {
  const p = musicProject()
  p.assets = p.assets.map((a) => (a.id === audioAsset.id ? { ...a, id: ASSET_ID } : a))
  const clip = findClip(p, 'clp_music')!.clip
  clip.assetId = ASSET_ID
  useProject.getState().load(p)
  useAnalysis.setState({ running: {}, results: {}, errors: {} })
  return p
}

const music = (): Clip => findClip(useProject.getState().project, 'clp_music')!.clip

describe('analysis store', () => {
  beforeEach(() => {
    load()
  })

  it('applies an existing analysis immediately (GET) as one undoable transaction', async () => {
    expect(await useAnalysis.getState().analyze('clp_music')).toBe(true)
    const c = music()
    expect(c.markers.length).toBeGreaterThan(300)
    expect(c.sections).toHaveLength(fixtures.musicAnalysis.sections.length)
    expect(useProject.getState().project.sections).toEqual([])
    expect(useProject.getState().history.past).toHaveLength(1)
    expect(useAnalysis.getState().results[ASSET_ID]?.bpm).toBe(fixtures.musicAnalysis.bpm)
    expect(useAnalysis.getState().running['clp_music']).toBeUndefined()

    useProject.getState().undo()
    expect(music().markers).toEqual([])
    expect(music().sections).toBeUndefined()
    expect(canUndo(useProject.getState())).toBe(false)
  })

  it('re-analysis with new params runs a job, replaces automatic markers and keeps manual ones', async () => {
    await useAnalysis.getState().analyze('clp_music')
    useProject.getState().dispatch([
      {
        op: 'addMarkers',
        target: { clipId: 'clp_music' },
        markers: [{ t: 33.3, kind: 'manual', strength: 1, label: 'мой' }],
      },
    ])
    const bassBefore = music().markers.filter((m) => m.kind === 'bass').length

    const done = useAnalysis.getState().analyze('clp_music', { params: { minGapSec: 0.6 } })
    expect(useAnalysis.getState().running['clp_music']).toBeDefined()
    expect(await done).toBe(true)

    const c = music()
    expect(c.markers.filter((m) => m.kind === 'manual')).toHaveLength(1)
    expect(c.markers.filter((m) => m.kind === 'bass').length).toBeLessThan(bassBefore)
    expect(useAnalysis.getState().results[ASSET_ID]?.params.minGapSec).toBe(0.6)
  }, 15_000)

  it('does not start a second analysis for the same clip while one is running', async () => {
    const first = useAnalysis.getState().analyze('clp_music')
    expect(await useAnalysis.getState().analyze('clp_music')).toBe(false)
    await first
  })

  it('autoAnalyzeClips only handles audio-track clips without markers', async () => {
    autoAnalyzeClips(['clp_a', 'clp_nope']) // видеоклип и несуществующий — игнорируются
    expect(useAnalysis.getState().running).toEqual({})
    autoAnalyzeClips(['clp_music'])
    expect(useAnalysis.getState().running['clp_music']).toBeDefined()
    await new Promise((r) => setTimeout(r, 300))
    expect(music().markers.length).toBeGreaterThan(0)
    // клип с маркерами повторно не анализируется
    autoAnalyzeClips(['clp_music'])
    expect(useAnalysis.getState().running).toEqual({})
  })

  it('reports an error for a clip that was removed during analysis', async () => {
    const p = useAnalysis.getState().analyze('clp_music', { params: { minGapSec: 0.5 } })
    useProject.getState().dispatch([{ op: 'removeClip', clipId: 'clp_music' }])
    expect(await p).toBe(false) // клипа уже нет: ops пустые, проект цел
    expect(findClip(useProject.getState().project, 'clp_music')).toBeUndefined()
  }, 15_000)
})
