import { describe, expect, it } from 'vitest'
import { applyOps } from './ops/applyOps'
import { sampleProject } from './testUtils'
import { displayOrder, moveTrackInDisplay, planTrackMove } from './tracks'

const ids = (tracks: readonly { id: string }[]) => tracks.map((t) => t.id)

describe('tracks', () => {
  it('display order: visual tracks top layer first, then audio', () => {
    expect(ids(displayOrder(sampleProject()))).toEqual(['trk_fx', 'trk_v2', 'trk_v1', 'trk_a1'])
  })

  it('planTrackMove gives a moveTrack op equal to the in-display reorder', () => {
    const p = sampleProject()
    const cases: [string, number][] = [
      ['trk_v1', 0],
      ['trk_fx', 2],
      ['trk_v2', 0],
      ['trk_v2', 1],
      ['trk_a1', 3],
    ]
    for (const [id, to] of cases) {
      const expected = { tracks: [...p.tracks] }
      const changed = moveTrackInDisplay(expected, id, to)
      const op = planTrackMove(p, id, to)
      if (!changed) {
        expect(op).toBeNull()
        continue
      }
      expect(op).not.toBeNull()
      expect(ids(applyOps(p, [op!]).project.tracks)).toEqual(ids(expected.tracks))
    }
  })

  it('visual tracks never move into the audio group', () => {
    const p = sampleProject()
    const op = planTrackMove(p, 'trk_fx', 10)
    expect(op).not.toBeNull()
    expect(ids(displayOrder(applyOps(p, [op!]).project))).toEqual(['trk_v2', 'trk_v1', 'trk_fx', 'trk_a1'])
  })
})
