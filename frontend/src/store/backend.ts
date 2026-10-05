import { create } from 'zustand'
import { api, ApiError } from '@/api/client'
import { events } from '@/api/events'
import type { WsStatus } from '@/api/ws'
import type { Health } from '@/shared/types.gen'

const POLL_OK_MS = 30_000
const POLL_FAIL_MS = 3_000

interface BackendState {
  health: Health | null
  error: string | null
  ws: WsStatus
  serverVersion: string | null
  checkedAt: number | null
  refresh: () => Promise<void>
}

export const useBackend = create<BackendState>()((set) => ({
  health: null,
  error: null,
  ws: 'closed',
  serverVersion: null,
  checkedAt: null,
  refresh: async () => {
    try {
      const health = await api.get<Health>('/health')
      set({ health, error: null, checkedAt: Date.now() })
    } catch (e) {
      const error = e instanceof ApiError ? e.message : 'Неизвестная ошибка'
      set({ health: null, error, checkedAt: Date.now() })
    }
  },
}))

/** Запускает опрос /health и WS-подключение. Возвращает функцию остановки. */
export function startBackendMonitor(): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  let stopped = false

  const tick = async () => {
    await useBackend.getState().refresh()
    if (stopped) return
    timer = setTimeout(tick, useBackend.getState().health ? POLL_OK_MS : POLL_FAIL_MS)
  }
  void tick()

  const offStatus = events.onStatus((ws) => {
    useBackend.setState({ ws })
    // Переподключился WS — значит бэк снова жив, проверяем /health сразу
    if (ws === 'open' && !useBackend.getState().health) void useBackend.getState().refresh()
  })
  const offHello = events.on('hello', (e) => useBackend.setState({ serverVersion: e.version }))
  events.start()

  return () => {
    stopped = true
    if (timer) clearTimeout(timer)
    offStatus()
    offHello()
    events.stop()
  }
}
