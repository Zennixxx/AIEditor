// Undo/redo на патчах Immer (produceWithPatches). Чистые функции над структурой History.
import { applyPatches, type Patch } from 'immer'
import type { Project } from '@/shared/types.gen'

export const HISTORY_LIMIT = 200

export interface HistoryEntry {
  label: string
  patches: Patch[]
  inverse: Patch[]
  /**
   * Ключ объединения: подряд идущие записи с одинаковым ключом (непрерывный drag/трим)
   * сливаются в одну, пока запись не «запечатана» (seal — по отпусканию мыши).
   */
  mergeKey?: string
  sealed: boolean
}

export interface History {
  past: HistoryEntry[]
  future: HistoryEntry[]
}

export function emptyHistory(): History {
  return { past: [], future: [] }
}

export interface NewEntry {
  label: string
  patches: Patch[]
  inverse: Patch[]
  mergeKey?: string
}

/** Добавляет запись (или сливает с предыдущей по mergeKey); очищает redo; держит лимит. */
export function record(h: History, entry: NewEntry, limit = HISTORY_LIMIT): History {
  if (entry.patches.length === 0) return h
  const last = h.past[h.past.length - 1]
  if (entry.mergeKey && last && !last.sealed && last.mergeKey === entry.mergeKey) {
    const merged: HistoryEntry = {
      ...last,
      patches: [...last.patches, ...entry.patches],
      inverse: [...entry.inverse, ...last.inverse],
    }
    return { past: [...h.past.slice(0, -1), merged], future: [] }
  }
  const past = [...h.past, { ...entry, sealed: !entry.mergeKey }]
  if (past.length > limit) past.splice(0, past.length - limit)
  return { past, future: [] }
}

/** Закрывает текущую объединяемую запись: следующая правка с тем же ключом станет новой записью. */
export function seal(h: History): History {
  const last = h.past[h.past.length - 1]
  if (!last || last.sealed) return h
  return { ...h, past: [...h.past.slice(0, -1), { ...last, sealed: true }] }
}

export function undo(
  h: History,
  project: Project,
): { history: History; project: Project; entry: HistoryEntry } | null {
  const entry = h.past[h.past.length - 1]
  if (!entry) return null
  return {
    project: applyPatches(project, entry.inverse),
    history: { past: h.past.slice(0, -1), future: [{ ...entry, sealed: true }, ...h.future] },
    entry,
  }
}

export function redo(
  h: History,
  project: Project,
): { history: History; project: Project; entry: HistoryEntry } | null {
  const entry = h.future[0]
  if (!entry) return null
  return {
    project: applyPatches(project, entry.patches),
    history: { past: [...h.past, entry], future: h.future.slice(1) },
    entry,
  }
}
