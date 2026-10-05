import { beforeEach, describe, expect, it } from 'vitest'
import { findClip } from '@/model/lookup'
import { sampleProject } from '@/model/testUtils'
import { HISTORY_LIMIT } from './history'
import { useProject } from './project'

const store = () => useProject.getState()
const startOf = (id: string) => findClip(store().project, id)!.clip.start

describe('project store', () => {
  beforeEach(() => store().load(sampleProject()))

  it('dispatch applies ops as one undoable transaction', () => {
    const res = store().dispatch([
      { op: 'moveClip', clipId: 'clp_b', start: 5 },
      { op: 'splitClip', clipId: 'clp_a', at: 1 },
    ])
    expect(res.ok).toBe(true)
    expect(store().project.tracks[0]!.items).toHaveLength(3)
    expect(store().history.past).toHaveLength(1)
    store().undo()
    expect(store().project.tracks[0]!.items).toHaveLength(2)
    expect(startOf('clp_b')).toBe(2)
    store().redo()
    expect(startOf('clp_b')).toBe(5)
  })

  it('rejected dispatch leaves project and history untouched', () => {
    const before = store().project
    const res = store().dispatch([{ op: 'moveClip', clipId: 'clp_b', start: 1 }])
    expect(res.ok).toBe(false)
    expect(store().project).toBe(before)
    expect(store().history.past).toHaveLength(0)
    expect(store().lastError).toBeTruthy()
  })

  it('merges continuous drag changes with the same mergeKey until sealed', () => {
    for (const s of [5, 5.5, 6])
      store().dispatch([{ op: 'moveClip', clipId: 'clp_b', start: s }], { mergeKey: 'drag:1' })
    expect(store().history.past).toHaveLength(1)
    store().sealHistory()
    store().dispatch([{ op: 'moveClip', clipId: 'clp_b', start: 7 }], { mergeKey: 'drag:1' })
    expect(store().history.past).toHaveLength(2)
    store().undo()
    expect(startOf('clp_b')).toBe(6)
    store().undo()
    expect(startOf('clp_b')).toBe(2)
  })

  it('transact records one entry and rejects invariant violations in dev', () => {
    expect(store().transact((d) => void (d.name = 'renamed'))).toBe(true)
    expect(store().project.name).toBe('renamed')
    const ok = store().transact((d) => {
      d.tracks[0]!.items[1]!.start = 1 // перекрытие с clp_a
    })
    expect(ok).toBe(false)
    expect(startOf('clp_b')).toBe(2)
    expect(store().history.past).toHaveLength(1)
  })

  it('new change clears redo; history is limited', () => {
    store().dispatch([{ op: 'moveClip', clipId: 'clp_b', start: 5 }])
    store().undo()
    store().dispatch([{ op: 'moveClip', clipId: 'clp_b', start: 6 }])
    expect(store().history.future).toHaveLength(0)
    for (let i = 0; i < HISTORY_LIMIT + 20; i++) {
      store().dispatch([{ op: 'moveClip', clipId: 'clp_b', start: 10 + (i % 2) }])
    }
    expect(store().history.past).toHaveLength(HISTORY_LIMIT)
  })
})
