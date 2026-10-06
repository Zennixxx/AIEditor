// ИИ-ассистент: чат с копилотом (`POST /ai/command`) и предпросмотр ops перед применением.
// ИИ никогда не меняет проект молча: ops показываются на таймлайне, «Применить» — одна запись undo.
import { create } from 'zustand'
import { aiApi } from '@/api/ai'
import { ApiError } from '@/api/client'
import { previewOps, type OpsPreview } from '@/ai/opsPreview'
import { findClip, findEffect } from '@/model/lookup'
import { newId } from '@/shared/ids'
import type { AICommandRequest, ChatTurn, EditOp, OpsResult, Project } from '@/shared/types.gen'
import { applyContext, useProject } from './project'
import { useUi } from './ui'

const HISTORY_TURNS = 10
const AUTO_ANALYZE_KEY = 'aieditor.ai.autoAnalyze'

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  warnings?: string[]
  error?: boolean
  /** Ответ с ops: ждёт решения, применён или отклонён. */
  status?: 'pending' | 'applied' | 'rejected'
}

export interface AiPreview extends OpsPreview {
  ops: EditOp[]
  explanation: string
  warnings: string[]
  /** Подпись записи истории. */
  label: string
  messageId: string | null
}

interface AiState {
  messages: ChatMessage[]
  busy: boolean
  preview: AiPreview | null
  autoAnalyze: boolean
  wizardOpen: boolean
  send: (text: string) => Promise<void>
  /** Показать результат с ops (копилот, автоэдит) для предпросмотра. */
  showResult: (result: OpsResult, label: string, messageId?: string | null) => void
  apply: () => boolean
  reject: () => void
  setAutoAnalyze: (on: boolean) => void
  setWizardOpen: (open: boolean) => void
  clear: () => void
}

function readAutoAnalyze(): boolean {
  try {
    return localStorage.getItem(AUTO_ANALYZE_KEY) === '1'
  } catch {
    return false
  }
}

export function errorText(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === 'gemini_not_configured')
      return 'Ключ Gemini не задан на бэке (GEMINI_API_KEY в backend/.env).'
    if (e.code === 'network_error') return 'Бэкенд недоступен.'
    return e.message
  }
  if (e instanceof Error) return e.message
  return 'Не удалось выполнить запрос'
}

export function buildCommandRequest(
  project: Project,
  message: string,
  history: ChatTurn[],
): AICommandRequest {
  const ui = useUi.getState()
  return {
    project,
    selection: {
      clipIds: ui.selection.filter((id) => !!findClip(project, id)),
      markerIds: [...ui.markerSelection],
      effectIds: ui.selection.filter((id) => !!findEffect(project, id)),
    },
    playhead: ui.playhead,
    message,
    ...(history.length ? { history } : {}),
  }
}

function makePreview(result: OpsResult, label: string, messageId: string | null): AiPreview {
  const preview = previewOps(useProject.getState().project, result.ops, applyContext())
  return {
    ...preview,
    ops: result.ops,
    explanation: result.explanation,
    warnings: result.warnings ?? [],
    label,
    messageId,
  }
}

export const useAi = create<AiState>()((set, get) => ({
  messages: [],
  busy: false,
  preview: null,
  autoAnalyze: readAutoAnalyze(),
  wizardOpen: false,

  send: async (raw) => {
    const text = raw.trim()
    if (!text || get().busy) return
    const history: ChatTurn[] = get()
      .messages.filter((m) => !m.error)
      .slice(-HISTORY_TURNS)
      .map((m) => ({ role: m.role, text: m.text }))
    const user: ChatMessage = { id: newId('x'), role: 'user', text }
    set((s) => ({ messages: [...s.messages, user], busy: true }))
    try {
      const result = await aiApi.command(buildCommandRequest(useProject.getState().project, text, history))
      const reply: ChatMessage = {
        id: newId('x'),
        role: 'assistant',
        text: result.explanation || (result.ops.length ? 'Готово.' : 'Нечего менять.'),
        ...(result.warnings?.length ? { warnings: result.warnings } : {}),
        ...(result.ops.length ? { status: 'pending' as const } : {}),
      }
      set((s) => ({ messages: [...s.messages, reply] }))
      if (result.ops.length) get().showResult(result, text, reply.id)
    } catch (e) {
      const reply: ChatMessage = { id: newId('x'), role: 'assistant', text: errorText(e), error: true }
      set((s) => ({ messages: [...s.messages, reply] }))
    } finally {
      set({ busy: false })
    }
  },

  showResult: (result, label, messageId = null) => {
    const prev = get().preview
    if (prev?.messageId) markMessage(prev.messageId, 'rejected')
    set({ preview: makePreview(result, label, messageId) })
  },

  apply: () => {
    const p = get().preview
    if (!p) return false
    set({ preview: null })
    const res = useProject.getState().dispatch(p.ops, { label: `ИИ: ${p.label}` })
    if (!res.ok) {
      set({ preview: { ...p, error: res.error.message } })
      return false
    }
    if (p.messageId) markMessage(p.messageId, 'applied')
    return true
  },

  reject: () => {
    const p = get().preview
    if (p?.messageId) markMessage(p.messageId, 'rejected')
    set({ preview: null })
  },

  setAutoAnalyze: (on) => {
    try {
      localStorage.setItem(AUTO_ANALYZE_KEY, on ? '1' : '0')
    } catch {
      // настройка останется только на время сессии
    }
    set({ autoAnalyze: on })
  },

  setWizardOpen: (open) => set({ wizardOpen: open }),

  clear: () => set({ messages: [], preview: null }),
}))

function markMessage(id: string, status: NonNullable<ChatMessage['status']>): void {
  useAi.setState((s) => ({ messages: s.messages.map((m) => (m.id === id ? { ...m, status } : m)) }))
}

/** Проект, который показывает таймлайн: при предпросмотре — результат ops. */
export function displayedProject(): Project {
  return useAi.getState().preview?.project ?? useProject.getState().project
}

// проект изменился, пока висит предпросмотр (undo, правка вручную) — пересчитать
useProject.subscribe((s, prev) => {
  const p = useAi.getState().preview
  if (!p || s.project === prev.project) return
  const result: OpsResult = { ops: p.ops, explanation: p.explanation, warnings: p.warnings }
  useAi.setState({ preview: makePreview(result, p.label, p.messageId) })
})
