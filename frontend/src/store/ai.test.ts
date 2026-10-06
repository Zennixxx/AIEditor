import { http, HttpResponse } from 'msw'
import { beforeEach, describe, expect, it } from 'vitest'
import { API_BASE } from '@/api/config'
import { fixtures } from '@/api/mocks/fixtures'
import { server } from '@/api/mocks/node'
import { buildCommandRequest, displayedProject, useAi } from './ai'
import { useProject } from './project'
import { useUi } from './ui'

const fxTracks = () => useProject.getState().project.tracks.filter((t) => t.kind === 'fx').length

describe('ai store', () => {
  beforeEach(() => {
    useProject.getState().load(structuredClone(fixtures.project))
    useAi.setState({ messages: [], busy: false, preview: null })
    useUi.getState().select([])
  })

  it('sends a command, previews ops and applies them as one undo entry', async () => {
    const before = useProject.getState().project
    await useAi.getState().send('шейк на сильные басы в дропе')
    const { messages, preview } = useAi.getState()
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(messages[1]!.text).toBe(fixtures.opsResult.explanation)
    expect(messages[1]!.status).toBe('pending')
    expect(preview?.ops).toEqual(fixtures.opsResult.ops)
    expect(preview?.error).toBeNull()
    expect(useProject.getState().project).toBe(before)
    expect(displayedProject()).toBe(preview?.project)

    expect(useAi.getState().apply()).toBe(true)
    expect(useAi.getState().preview).toBeNull()
    expect(useAi.getState().messages[1]!.status).toBe('applied')
    expect(fxTracks()).toBe(3)
    expect(useProject.getState().history.past).toHaveLength(1)
    expect(useProject.getState().history.past[0]!.label).toBe('ИИ: шейк на сильные басы в дропе')

    useProject.getState().undo()
    expect(useProject.getState().project).toEqual(before)
  })

  it('rejects a preview without touching the project', async () => {
    await useAi.getState().send('шейк')
    useAi.getState().reject()
    expect(useAi.getState().preview).toBeNull()
    expect(useAi.getState().messages[1]!.status).toBe('rejected')
    expect(useProject.getState().history.past).toHaveLength(0)
  })

  it('recomputes the preview when the project changes underneath', async () => {
    await useAi.getState().send('шейк')
    useProject.getState().dispatch([{ op: 'removeClip', clipId: 'clp_drop000001' }])
    expect(useAi.getState().preview?.error).toBeTruthy()
    expect(useAi.getState().preview?.project).toBeNull()
  })

  it('shows backend errors as assistant messages', async () => {
    server.use(
      http.post(`${API_BASE}/ai/command`, () =>
        HttpResponse.json(
          { error: { code: 'gemini_not_configured', message: 'Ключ Gemini не задан' } },
          { status: 503 },
        ),
      ),
    )
    await useAi.getState().send('шейк')
    const reply = useAi.getState().messages[1]!
    expect(reply.error).toBe(true)
    expect(reply.text).toContain('GEMINI_API_KEY')
    expect(useAi.getState().preview).toBeNull()
  })

  it('builds the request from selection, playhead and history', () => {
    const p = useProject.getState().project
    useUi.getState().select(['clp_drop000001', 'fx_shake00001'])
    useUi.getState().setPlayhead(31.5)
    const req = buildCommandRequest(p, 'замедли', [{ role: 'user', text: 'привет' }])
    expect(req.selection).toEqual({
      clipIds: ['clp_drop000001'],
      markerIds: [],
      effectIds: ['fx_shake00001'],
    })
    expect(req.playhead).toBe(31.5)
    expect(req.history).toHaveLength(1)
    expect(buildCommandRequest(p, 'x', []).history).toBeUndefined()
  })
})
