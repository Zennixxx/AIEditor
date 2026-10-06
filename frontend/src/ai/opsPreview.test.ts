import { describe, expect, it } from 'vitest'
import { fixtures } from '@/api/mocks/fixtures'
import type { EditOp } from '@/shared/types.gen'
import { describeFilter, describeOps, previewOps } from './opsPreview'

const project = () => structuredClone(fixtures.project)

describe('previewOps', () => {
  it('applies ops to a copy and reports created and changed items', () => {
    const p = project()
    const res = previewOps(p, fixtures.opsResult.ops)
    expect(res.error).toBeNull()
    expect(res.project).not.toBeNull()
    expect(p).toEqual(fixtures.project)
    const newTrack = res.project!.tracks.find((t) => t.name === 'AI: шейк')!
    expect(res.created.has(newTrack.id)).toBe(true)
    expect(newTrack.items.length).toBeGreaterThan(0)
    expect(newTrack.items.every((i) => res.created.has(i.id))).toBe(true)
    expect(res.changed.has('clp_drop000001')).toBe(true)
    expect(res.changed.has('clp_intro00001')).toBe(false)
    expect(res.removed).toEqual([])
  })

  it('returns an error instead of throwing when ops do not apply', () => {
    const res = previewOps(project(), [{ op: 'removeClip', clipId: 'clp_missing00' }])
    expect(res.project).toBeNull()
    expect(res.error).toBeTruthy()
    expect(res.lines).toEqual(['Удалить клип «clp_missing00»'])
  })

  it('reports removed items', () => {
    const res = previewOps(project(), [{ op: 'removeClip', clipId: 'clp_intro00001' }])
    expect(res.removed).toEqual(['clp_intro00001'])
  })
})

describe('describeOps', () => {
  it('describes the fixture ops in human language', () => {
    const lines = describeOps(project(), fixtures.opsResult.ops)
    expect(lines).toHaveLength(3)
    expect(lines[0]).toBe('Новая fx-дорожка «AI: шейк»')
    expect(lines[1]).toContain(
      '«Шейк» на маркеры (басы, сила ≥ 0.6, секции: drop, сила по маркеру) → «AI: шейк»',
    )
    expect(lines[2]).toMatch(/^Speed ramp на «/)
  })

  it('groups long runs of the same primitive op', () => {
    const clip = fixtures.project.tracks[0]!.items[0]!
    if (clip.type !== 'clip') throw new Error('fixture')
    const add = (start: number): EditOp => ({
      op: 'addClip',
      trackId: 'tmp_v',
      clip: { ...clip, id: undefined, start },
    })
    const ops: EditOp[] = [
      {
        op: 'addTrack',
        track: { id: 'tmp_v', kind: 'video', name: 'Авто', muted: false, locked: false, hidden: false },
      },
      ...[100, 110, 120, 130, 140].map(add),
    ]
    expect(describeOps(project(), ops)).toEqual(['Новая видео-дорожка «Авто»', 'Добавить клипы: 5'])
    expect(describeOps(project(), ops.slice(0, 3))[1]).toMatch(
      /^Клип «intro slow» на 100\.00 с \(15\.00 с\) → «Авто»$/,
    )
  })

  it('describes marker filters', () => {
    expect(
      describeFilter({ kinds: ['beat', 'downbeat'], every: 4, offset: 1, range: { start: 1, end: 2.5 } }),
    ).toBe('биты, даунбиты, каждый 4-й со сдвигом 1, 1.00 с–2.50 с')
    expect(describeFilter({})).toBe('басы')
  })
})
