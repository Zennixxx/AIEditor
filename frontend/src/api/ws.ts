import type { WsEvent } from '@/shared/types.gen'

export type WsStatus = 'connecting' | 'open' | 'closed'

type EventType = WsEvent['type']
type EventOf<T extends EventType> = Extract<WsEvent, { type: T }>
type Listener<T extends EventType> = (event: EventOf<T>) => void

const MIN_RETRY_MS = 500
const MAX_RETRY_MS = 5000

/** WS-подписка на события бэка (CONTRACT §8) с автопереподключением. */
export class EventsSocket {
  private socket: WebSocket | null = null
  private retryMs = MIN_RETRY_MS
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private stopped = true
  private listeners = new Map<EventType, Set<(e: WsEvent) => void>>()
  private statusListeners = new Set<(s: WsStatus) => void>()
  private _status: WsStatus = 'closed'

  constructor(private readonly url: string) {}

  get status(): WsStatus {
    return this._status
  }

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.connect()
  }

  stop(): void {
    this.stopped = true
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
    this.socket?.close()
    this.socket = null
    this.setStatus('closed')
  }

  on<T extends EventType>(type: T, fn: Listener<T>): () => void {
    let set = this.listeners.get(type)
    if (!set) {
      set = new Set()
      this.listeners.set(type, set)
    }
    const wrapped = fn as (e: WsEvent) => void
    set.add(wrapped)
    return () => set.delete(wrapped)
  }

  onStatus(fn: (s: WsStatus) => void): () => void {
    this.statusListeners.add(fn)
    return () => this.statusListeners.delete(fn)
  }

  private connect(): void {
    this.setStatus('connecting')
    const socket = new WebSocket(this.url)
    this.socket = socket
    socket.onopen = () => {
      this.retryMs = MIN_RETRY_MS
      this.setStatus('open')
    }
    socket.onmessage = (msg) => {
      let event: WsEvent
      try {
        event = JSON.parse(String(msg.data)) as WsEvent
      } catch {
        return
      }
      this.listeners.get(event.type)?.forEach((fn) => fn(event))
    }
    socket.onclose = () => {
      if (this.socket !== socket) return
      this.socket = null
      this.setStatus('closed')
      this.scheduleReconnect()
    }
    socket.onerror = () => socket.close()
  }

  private scheduleReconnect(): void {
    if (this.stopped) return
    this.retryTimer = setTimeout(() => this.connect(), this.retryMs)
    this.retryMs = Math.min(this.retryMs * 2, MAX_RETRY_MS)
  }

  private setStatus(s: WsStatus): void {
    if (this._status === s) return
    this._status = s
    this.statusListeners.forEach((fn) => fn(s))
  }
}
