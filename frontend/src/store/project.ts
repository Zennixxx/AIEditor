// Проект в памяти + единственные точки изменения: dispatch(ops) и transact(recipe).
// Каждая транзакция — одна запись истории (store/history.ts).
import { enablePatches, produce, produceWithPatches, type Draft } from 'immer'
import { create } from 'zustand'
import { checkInvariants } from '@/model/invariants'
import { applyOpsToDraft, OpsError, type ApplyContext, type ApplyOutcome } from '@/model/ops/applyOps'
import { createEmptyProject, finalizeProject } from '@/model/project'
import type { Asset, EditOp, Project } from '@/shared/types.gen'
import * as hist from './history'

enablePatches()

const DEV = import.meta.env.DEV

export interface TxOptions {
  /** Подпись записи истории («Разрезать», «Переместить»…). */
  label?: string
  /** Ключ объединения непрерывных изменений (drag/трим) в одну запись истории. */
  mergeKey?: string
}

export type DispatchResult = ({ ok: true } & ApplyOutcome) | { ok: false; error: OpsError }

interface ProjectState {
  project: Project
  history: hist.History
  /** Последняя ошибка транзакции (для тоста/статуса). */
  lastError: string | null
  load: (project: Project) => void
  dispatch: (ops: readonly EditOp[], opts?: TxOptions) => DispatchResult
  transact: (recipe: (draft: Draft<Project>) => void, opts?: TxOptions) => boolean
  undo: () => boolean
  redo: () => boolean
  /** Закрыть текущую объединяемую запись истории (конец drag). */
  sealHistory: () => void
  /** Обновить копию метаданных ассета (WS-событие `asset`) — без записи в историю. */
  syncAsset: (asset: Asset) => void
  setInterpolated: (changes: Readonly<Record<string, string | null>>) => void
}

let applyCtx: ApplyContext = {}

/** Подключение внешних зависимостей applyOps (библиотека ассетов). */
export function configureProjectStore(ctx: ApplyContext): void {
  applyCtx = ctx
}

export function applyContext(): ApplyContext {
  return applyCtx
}

export const useProject = create<ProjectState>()((set, get) => ({
  project: createEmptyProject(),
  history: hist.emptyHistory(),
  lastError: null,

  load: (project) => set({ project, history: hist.emptyHistory(), lastError: null }),

  dispatch: (ops, opts = {}) => {
    if (ops.length === 0) return { ok: true, idMap: {}, created: [] }
    let outcome: ApplyOutcome = { idMap: {}, created: [] }
    try {
      const [project, patches, inverse] = produceWithPatches(get().project, (d) => {
        outcome = applyOpsToDraft(d, ops, applyCtx)
      })
      commit(project, patches, inverse, opts.label ?? ops.map((o) => o.op).join(', '), opts.mergeKey)
      return { ok: true, ...outcome }
    } catch (e) {
      if (!(e instanceof OpsError)) throw e
      if (DEV) console.warn('[dispatch] отклонено:', e.message, e.details ?? '')
      set({ lastError: e.message })
      return { ok: false, error: e }
    }
  },

  transact: (recipe, opts = {}) => {
    try {
      const [project, patches, inverse] = produceWithPatches(get().project, (d) => {
        recipe(d)
        finalizeProject(d as Project)
        if (DEV) {
          const violations = checkInvariants(d as Project)
          if (violations.length > 0) {
            throw new OpsError('invariant_violation', violations[0]!.message, {
              details: violations.map((v) => v.message),
            })
          }
        }
      })
      commit(project, patches, inverse, opts.label ?? 'Изменение', opts.mergeKey)
      return true
    } catch (e) {
      if (!(e instanceof OpsError)) throw e
      console.error('[transact] нарушены инварианты, изменение отменено:', e.details)
      set({ lastError: e.message })
      return false
    }
  },

  undo: () => {
    const res = hist.undo(get().history, get().project)
    if (!res) return false
    set({ project: res.project, history: res.history })
    return true
  },

  redo: () => {
    const res = hist.redo(get().history, get().project)
    if (!res) return false
    set({ project: res.project, history: res.history })
    return true
  },

  sealHistory: () => set({ history: hist.seal(get().history) }),

  syncAsset: (asset) => {
    const { project } = get()
    const i = project.assets.findIndex((a) => a.id === asset.id)
    if (i < 0) return
    const assets = [...project.assets]
    assets[i] = asset
    set({ project: { ...project, assets } })
  },

  setInterpolated: (changes) => {
    const ids = Object.keys(changes)
    if (ids.length === 0) return
    const project = produce(get().project, (d) => {
      for (const track of d.tracks) {
        for (const item of track.items) {
          if (item.type !== 'clip' || !(item.id in changes)) continue
          const value = changes[item.id]
          if (value) item.interpolatedAssetId = value
          else delete item.interpolatedAssetId
        }
      }
    })
    if (project !== get().project) set({ project })
  },
}))

function commit(
  project: Project,
  patches: hist.NewEntry['patches'],
  inverse: hist.NewEntry['inverse'],
  label: string,
  mergeKey?: string,
): void {
  const { history } = useProject.getState()
  useProject.setState({
    project,
    history: hist.record(history, { label, patches, inverse, ...(mergeKey ? { mergeKey } : {}) }),
    lastError: null,
  })
}

export function canUndo(s: Pick<ProjectState, 'history'>): boolean {
  return s.history.past.length > 0
}

export function canRedo(s: Pick<ProjectState, 'history'>): boolean {
  return s.history.future.length > 0
}
