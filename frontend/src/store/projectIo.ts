// Проекты на бэке: открытие, создание, удаление, «Недавние» и автосейв (CONTRACT §9).
import { create } from 'zustand'
import { ApiError, apiUrl } from '@/api/client'
import { projectsApi } from '@/api/projects'
import { createEmptyProject } from '@/model/project'
import type { Project, ProjectListItem } from '@/shared/types.gen'
import { useAssets } from './assets'
import { useProject } from './project'
import { useUi } from './ui'

export const AUTOSAVE_DELAY_MS = 2000
const RETRY_MS = 5000
const RECENT_KEY = 'aieditor.recentProjects'
const RECENT_LIMIT = 10
/** Лимит тела `fetch(keepalive)` в браузерах — 64 КБ. */
const KEEPALIVE_LIMIT = 60_000

export type SaveStatus = 'new' | 'saved' | 'dirty' | 'saving' | 'error' | 'conflict'

export interface RecentProject {
  id: string
  name: string
  openedAt: string
}

interface SaveState {
  status: SaveStatus
  error: string | null
  savedAt: string | null
  /** Ревизия на бэке при конфликте 409. */
  conflictRevision: number | null
  recent: RecentProject[]
  projects: ProjectListItem[]
  projectsError: string | null
}

function readRecent(): RecentProject[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY)
    const list: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(list) ? (list as RecentProject[]).filter((r) => typeof r?.id === 'string') : []
  } catch {
    return []
  }
}

function writeRecent(recent: RecentProject[]): void {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(recent))
  } catch {
    // localStorage недоступен — «Недавние» живут до перезагрузки
  }
}

export const useSave = create<SaveState>()(() => ({
  status: 'new',
  error: null,
  savedAt: null,
  conflictRevision: null,
  recent: readRecent(),
  projects: [],
  projectsError: null,
}))

/** Версия проекта, совпадающая с сохранённой на бэке (или новый нетронутый проект). */
let baseline: Project = useProject.getState().project
let timer: ReturnType<typeof setTimeout> | null = null
let inflight: Promise<void> | null = null

function setStatus(status: SaveStatus, extra: Partial<SaveState> = {}): void {
  useSave.setState({ status, ...extra })
}

function rememberRecent(p: Pick<Project, 'id' | 'name'>): void {
  const entry: RecentProject = { id: p.id, name: p.name, openedAt: new Date().toISOString() }
  const recent = [entry, ...useSave.getState().recent.filter((r) => r.id !== p.id)].slice(0, RECENT_LIMIT)
  useSave.setState({ recent })
  writeRecent(recent)
}

function forgetRecent(id: string): void {
  const recent = useSave.getState().recent.filter((r) => r.id !== id)
  useSave.setState({ recent })
  writeRecent(recent)
}

export function isDirty(): boolean {
  return useProject.getState().project !== baseline
}

function schedule(delay = AUTOSAVE_DELAY_MS): void {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    timer = null
    void saveNow()
  }, delay)
}

/** Сохранить текущий проект сейчас (если есть несохранённые изменения). */
export function saveNow(): Promise<void> {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  if (inflight) return inflight.then(() => (isDirty() ? saveNow() : undefined))
  if (!isDirty() || useSave.getState().status === 'conflict') return Promise.resolve()
  const sent = useProject.getState().project
  setStatus('saving', { error: null })
  const run = (async () => {
    try {
      const res = await projectsApi.save(sent)
      const cur = useProject.getState().project
      if (cur.id !== sent.id) return
      const next: Project = { ...cur, revision: res.revision, updatedAt: res.updatedAt }
      if (cur === sent) baseline = next
      useProject.setState({ project: next })
      rememberRecent(next)
      setStatus(cur === sent ? 'saved' : 'dirty', { savedAt: res.updatedAt, error: null })
    } catch (e) {
      if (useProject.getState().project.id !== sent.id) return
      if (e instanceof ApiError && e.code === 'revision_conflict') {
        const revision = typeof e.details?.revision === 'number' ? e.details.revision : null
        setStatus('conflict', { error: e.message, conflictRevision: revision })
        return
      }
      setStatus('error', { error: e instanceof Error ? e.message : 'Ошибка сохранения' })
      schedule(RETRY_MS)
    } finally {
      inflight = null
    }
  })()
  inflight = run
  return run.then(() => {
    if (isDirty() && useSave.getState().status === 'dirty') schedule()
  })
}

function adopt(project: Project, onServer: boolean): void {
  if (timer) clearTimeout(timer)
  timer = null
  baseline = project
  useProject.getState().load(project)
  useUi.setState({
    selection: [],
    markerSelection: [],
    keySelection: [],
    playhead: 0,
    scrollX: 0,
    scrollY: 0,
    inPoint: null,
    outPoint: null,
    curveEditorClipId: null,
  })
  setStatus(onServer ? 'saved' : 'new', {
    error: null,
    conflictRevision: null,
    savedAt: onServer ? project.updatedAt : null,
  })
  if (onServer) rememberRecent(project)
}

async function leaveCurrent(): Promise<void> {
  if (useSave.getState().status === 'conflict') return
  await saveNow().catch(() => undefined)
}

export async function openProject(id: string): Promise<void> {
  await leaveCurrent()
  let project: Project
  try {
    project = await projectsApi.get(id)
  } catch (e) {
    if (e instanceof ApiError && e.code === 'project_not_found') forgetRecent(id)
    throw e
  }
  for (const a of project.assets) if (!useAssets.getState().assets[a.id]) useAssets.getState().upsertAsset(a)
  adopt(project, true)
}

export async function newProject(
  opts: Partial<Pick<Project, 'name' | 'fps' | 'width' | 'height'>> = {},
): Promise<void> {
  await leaveCurrent()
  adopt(createEmptyProject(opts), false)
}

export async function deleteProject(id: string): Promise<void> {
  const current = useProject.getState().project.id === id
  if (current && timer) clearTimeout(timer)
  try {
    await projectsApi.remove(id)
  } catch (e) {
    if (!(e instanceof ApiError && e.code === 'project_not_found')) throw e
  }
  forgetRecent(id)
  useSave.setState((s) => ({ projects: s.projects.filter((p) => p.id !== id) }))
  if (current) adopt(createEmptyProject(), false)
}

export function renameProject(name: string): void {
  const trimmed = name.trim()
  if (!trimmed || trimmed === useProject.getState().project.name) return
  useProject.getState().transact(
    (d) => {
      d.name = trimmed
    },
    { label: 'Переименовать проект' },
  )
}

export async function refreshProjects(): Promise<void> {
  try {
    const projects = await projectsApi.list()
    useSave.setState({ projects, projectsError: null })
  } catch (e) {
    useSave.setState({ projectsError: e instanceof Error ? e.message : 'Не удалось загрузить проекты' })
  }
}

/** Конфликт 409: взять версию с бэка, отбросив свои изменения. */
export async function resolveConflictReload(): Promise<void> {
  const id = useProject.getState().project.id
  setStatus('saved', { conflictRevision: null })
  baseline = useProject.getState().project
  await openProject(id)
}

/** Конфликт 409: перезаписать версию на бэке своей. */
export async function resolveConflictOverwrite(): Promise<void> {
  const cur = useProject.getState().project
  let revision = useSave.getState().conflictRevision
  if (revision === null) revision = (await projectsApi.get(cur.id)).revision
  useProject.setState({ project: { ...useProject.getState().project, revision } })
  setStatus('dirty', { conflictRevision: null, error: null })
  await saveNow()
}

/** При старте открыть последний проект из «Недавних», если пользователь ещё ничего не менял. */
export async function restoreLastProject(): Promise<void> {
  const last = useSave.getState().recent[0]
  if (!last) return
  const untouched = useProject.getState().project
  try {
    const project = await projectsApi.get(last.id)
    if (useProject.getState().project !== untouched || isDirty()) return
    for (const a of project.assets)
      if (!useAssets.getState().assets[a.id]) useAssets.getState().upsertAsset(a)
    adopt(project, true)
  } catch (e) {
    if (e instanceof ApiError && e.code === 'project_not_found') forgetRecent(last.id)
  }
}

function sendOnUnload(): boolean {
  if (!isDirty()) return true
  const project = useProject.getState().project
  const body = JSON.stringify(project)
  if (body.length > KEEPALIVE_LIMIT) return false
  try {
    void fetch(apiUrl(`/projects/${project.id}`), {
      method: 'PUT',
      body,
      headers: { 'Content-Type': 'application/json' },
      keepalive: true,
    }).catch(() => undefined)
    return true
  } catch {
    return false
  }
}

/** Автосейв: через 2 с после изменения, при уходе со вкладки и при её закрытии. Возвращает остановку. */
export function startAutosave(): () => void {
  baseline = useProject.getState().project
  const unsub = useProject.subscribe((s, prev) => {
    if (s.project === prev.project) return
    if (s.project.id !== prev.project.id && s.project !== baseline) {
      baseline = s.project
      return
    }
    if (s.project === baseline) return
    if (useSave.getState().status === 'conflict') return
    if (useSave.getState().status !== 'saving') setStatus('dirty')
    schedule()
  })
  const onVisibility = () => {
    if (document.visibilityState === 'hidden' && isDirty()) void saveNow()
  }
  const onPageHide = () => {
    if (!inflight) sendOnUnload()
  }
  const onBeforeUnload = (e: BeforeUnloadEvent) => {
    if (isDirty() && JSON.stringify(useProject.getState().project).length > KEEPALIVE_LIMIT)
      e.preventDefault()
  }
  document.addEventListener('visibilitychange', onVisibility)
  window.addEventListener('pagehide', onPageHide)
  window.addEventListener('beforeunload', onBeforeUnload)
  return () => {
    unsub()
    if (timer) clearTimeout(timer)
    timer = null
    document.removeEventListener('visibilitychange', onVisibility)
    window.removeEventListener('pagehide', onPageHide)
    window.removeEventListener('beforeunload', onBeforeUnload)
  }
}
