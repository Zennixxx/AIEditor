import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { API_BASE } from '@/api/config'
import { server } from '@/api/mocks/node'
import { projectsApi } from '@/api/projects'
import { createEmptyProject } from '@/model/project'
import type { Project } from '@/shared/types.gen'
import { useProject } from './project'
import {
  AUTOSAVE_DELAY_MS,
  deleteProject,
  isDirty,
  newProject,
  openProject,
  renameProject,
  resolveConflictOverwrite,
  resolveConflictReload,
  restoreLastProject,
  saveNow,
  startAutosave,
  useSave,
} from './projectIo'

const addMarker = (t: number) =>
  useProject
    .getState()
    .dispatch([{ op: 'addMarkers', target: 'project', markers: [{ t, kind: 'manual', strength: 1 }] }])

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(0)
}

describe('autosave and projects', () => {
  let stop: () => void

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    localStorage.clear()
    useSave.setState({ recent: [], projects: [], status: 'new', error: null, conflictRevision: null })
    stop = startAutosave()
    await newProject({ name: 'Тест' })
  })

  afterEach(() => {
    stop()
    vi.useRealTimers()
  })

  it('a new untouched project is not saved; the first edit creates it with PUT revision 0', async () => {
    const id = useProject.getState().project.id
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS * 2)
    await expect(projectsApi.get(id)).rejects.toMatchObject({ code: 'project_not_found' })
    expect(useSave.getState().status).toBe('new')

    addMarker(1)
    expect(useSave.getState().status).toBe('dirty')
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS - 100)
    await expect(projectsApi.get(id)).rejects.toMatchObject({ code: 'project_not_found' })
    await vi.advanceTimersByTimeAsync(200)
    await settle()
    expect(useSave.getState().status).toBe('saved')
    expect(useProject.getState().project.revision).toBe(1)
    expect(isDirty()).toBe(false)
    const saved = await projectsApi.get(id)
    expect(saved.markers).toHaveLength(1)
    expect(useSave.getState().recent[0]).toMatchObject({ id, name: 'Тест' })
  })

  it('edits made during a save are kept and saved next; undo history survives', async () => {
    addMarker(1)
    const pending = saveNow()
    addMarker(2)
    await pending
    await settle()
    const p = useProject.getState().project
    expect(p.markers).toHaveLength(2)
    expect(p.revision).toBe(1)
    expect(isDirty()).toBe(true)
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS + 10)
    await settle()
    expect(useProject.getState().project.revision).toBe(2)
    expect((await projectsApi.get(p.id)).markers).toHaveLength(2)
    expect(useProject.getState().undo()).toBe(true)
    expect(useProject.getState().project.markers).toHaveLength(1)
    expect(useProject.getState().project.revision).toBe(2)
  })

  it('rename is an undoable edit and is saved', async () => {
    renameProject('  Новое имя ')
    await saveNow()
    expect((await projectsApi.get(useProject.getState().project.id)).name).toBe('Новое имя')
    renameProject('   ')
    expect(useProject.getState().project.name).toBe('Новое имя')
  })

  it('409: reload takes the server version, overwrite pushes ours', async () => {
    addMarker(1)
    await saveNow()
    const id = useProject.getState().project.id
    const other: Project = { ...(await projectsApi.get(id)), name: 'Из другого окна' }
    await projectsApi.save(other)

    addMarker(2)
    await saveNow()
    expect(useSave.getState()).toMatchObject({ status: 'conflict', conflictRevision: 2 })
    addMarker(3)
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS * 2)
    expect(useSave.getState().status).toBe('conflict')

    await resolveConflictOverwrite()
    expect(useSave.getState().status).toBe('saved')
    const server1 = await projectsApi.get(id)
    expect(server1.markers).toHaveLength(3)
    expect(server1.revision).toBe(3)

    await projectsApi.save({ ...server1, name: 'Снова другое окно' })
    addMarker(4)
    await saveNow()
    expect(useSave.getState().status).toBe('conflict')
    await resolveConflictReload()
    expect(useProject.getState().project.name).toBe('Снова другое окно')
    expect(useProject.getState().project.markers).toHaveLength(3)
    expect(useSave.getState().status).toBe('saved')
  })

  it('network error retries later', async () => {
    let fail = true
    server.use(
      http.put(`${API_BASE}/projects/:id`, () =>
        fail ? HttpResponse.error() : HttpResponse.json(null, { status: 500 }),
      ),
    )
    addMarker(1)
    await saveNow()
    expect(useSave.getState().status).toBe('error')
    fail = false
    server.resetHandlers()
    await vi.advanceTimersByTimeAsync(6000)
    await settle()
    expect(useSave.getState().status).toBe('saved')
  })

  it('opening another project saves the current one first; delete of the current starts a new one', async () => {
    addMarker(1)
    const first = useProject.getState().project.id
    await openProject('prj_demo000001')
    expect(useProject.getState().project.name).toBe('Demo phonk edit')
    expect((await projectsApi.get(first)).markers).toHaveLength(1)
    expect(useSave.getState().recent.map((r) => r.id)).toEqual(['prj_demo000001', first])

    await deleteProject(first)
    expect(useSave.getState().recent.map((r) => r.id)).toEqual(['prj_demo000001'])
    await deleteProject('prj_demo000001')
    expect(useProject.getState().project.id).not.toBe('prj_demo000001')
    expect(useSave.getState().status).toBe('new')
    expect(useSave.getState().recent).toEqual([])
  })

  it('restoreLastProject opens the most recent project, forgets missing ones', async () => {
    const saved = createEmptyProject({ name: 'Последний' })
    await projectsApi.save(saved)
    useSave.setState({
      recent: [
        { id: saved.id, name: 'Последний', openedAt: '' },
        { id: 'prj_gone', name: 'Удалён', openedAt: '' },
      ],
    })
    await newProject()
    await restoreLastProject()
    expect(useProject.getState().project).toMatchObject({ id: saved.id, revision: 1 })

    useSave.setState({ recent: [{ id: 'prj_gone', name: 'Удалён', openedAt: '' }] })
    await newProject()
    await restoreLastProject()
    expect(useProject.getState().project.name).toBe('Без названия')
    expect(useSave.getState().recent).toEqual([])
  })

  it('restoreLastProject does not replace a project the user already edits', async () => {
    const saved = createEmptyProject({ name: 'Последний' })
    await projectsApi.save(saved)
    useSave.setState({ recent: [{ id: saved.id, name: 'Последний', openedAt: '' }] })
    const restoring = restoreLastProject()
    addMarker(1)
    await restoring
    expect(useProject.getState().project.name).toBe('Тест')
  })
})
