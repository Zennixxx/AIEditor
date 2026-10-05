import type { ApiErrorBody } from '@/shared/types.gen'
import { API_BASE } from './config'

/** Ошибка API в формате CONTRACT §1: {"error": {code, message, details}}. */
export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly details?: Record<string, unknown>

  constructor(status: number, code: string, message: string, details?: Record<string, unknown>) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.details = details
  }
}

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE'

function isErrorBody(x: unknown): x is { error: ApiErrorBody } {
  return (
    typeof x === 'object' && x !== null && 'error' in x && typeof (x as { error: unknown }).error === 'object'
  )
}

async function request<T>(method: Method, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const init: RequestInit = { method, signal }
  if (body instanceof FormData) {
    init.body = body
  } else if (body !== undefined) {
    init.body = JSON.stringify(body)
    init.headers = { 'Content-Type': 'application/json' }
  }

  let res: Response
  try {
    res = await fetch(apiUrl(path), init)
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e
    throw new ApiError(0, 'network_error', 'Бэкенд недоступен')
  }

  const text = await res.text()
  const data: unknown = text ? safeJson(text) : undefined
  if (!res.ok) {
    if (isErrorBody(data)) {
      throw new ApiError(res.status, data.error.code, data.error.message, data.error.details)
    }
    throw new ApiError(res.status, 'http_error', `HTTP ${res.status}`)
  }
  return data as T
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/** Абсолютный URL ресурса бэка. Принимает путь относительно API (`/health`) или уже полный `/api/...`. */
export function apiUrl(path: string): string {
  if (/^https?:\/\//.test(path)) return path
  if (path.startsWith('/api/')) return API_BASE.replace(/\/api$/, '') + path
  return API_BASE + path
}

export const api = {
  get: <T>(path: string, signal?: AbortSignal) => request<T>('GET', path, undefined, signal),
  post: <T>(path: string, body?: unknown, signal?: AbortSignal) => request<T>('POST', path, body, signal),
  put: <T>(path: string, body?: unknown, signal?: AbortSignal) => request<T>('PUT', path, body, signal),
  del: <T>(path: string, signal?: AbortSignal) => request<T>('DELETE', path, undefined, signal),
}
