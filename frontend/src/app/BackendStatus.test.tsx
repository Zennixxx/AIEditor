import { act, render, screen } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { beforeEach, describe, expect, it } from 'vitest'
import { API_BASE } from '@/api/config'
import { server } from '@/api/mocks/node'
import { useBackend } from '@/store/backend'
import { BackendStatus } from './BackendStatus'

describe('BackendStatus', () => {
  beforeEach(() => {
    useBackend.setState({ health: null, error: null, ws: 'closed', serverVersion: null, checkedAt: null })
  })

  it('shows capabilities when backend is healthy and WS is open', async () => {
    await act(() => useBackend.getState().refresh())
    act(() => useBackend.setState({ ws: 'open' }))
    render(<BackendStatus />)
    expect(screen.getByTestId('backend-status')).toHaveAttribute('data-level', 'ok')
    expect(screen.getByText('Бэкенд подключён')).toBeInTheDocument()
    expect(screen.getByText('ffmpeg')).toHaveAttribute('data-on', 'true')
    expect(screen.getByText('Demucs')).toHaveAttribute('data-on', 'false')
  })

  it('warns when WS is not connected', async () => {
    await act(() => useBackend.getState().refresh())
    render(<BackendStatus />)
    expect(screen.getByTestId('backend-status')).toHaveAttribute('data-level', 'warn')
  })

  it('shows error when backend is down', async () => {
    server.use(http.get(`${API_BASE}/health`, () => HttpResponse.error()))
    await act(() => useBackend.getState().refresh())
    render(<BackendStatus />)
    expect(screen.getByTestId('backend-status')).toHaveAttribute('data-level', 'err')
    expect(screen.getByText('Бэкенд недоступен')).toBeInTheDocument()
  })
})
