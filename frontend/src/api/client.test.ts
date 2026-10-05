import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import type { Health } from '@/shared/types.gen'
import { api, ApiError, apiUrl } from './client'
import { API_BASE } from './config'
import { fixtures } from './mocks/fixtures'
import { server } from './mocks/node'

describe('api client', () => {
  it('returns parsed JSON', async () => {
    await expect(api.get<Health>('/health')).resolves.toEqual(fixtures.health)
  })

  it('maps error body to ApiError', async () => {
    const err = await api.get('/jobs/job_missing').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err).toMatchObject({ status: 404, code: 'job_not_found' })
  })

  it('maps network failure to ApiError(network_error)', async () => {
    server.use(http.get(`${API_BASE}/health`, () => HttpResponse.error()))
    const err = await api.get('/health').catch((e: unknown) => e)
    expect(err).toMatchObject({ status: 0, code: 'network_error' })
  })

  it('falls back to http_error for non-contract errors', async () => {
    server.use(http.get(`${API_BASE}/health`, () => new HttpResponse('boom', { status: 500 })))
    const err = await api.get('/health').catch((e: unknown) => e)
    expect(err).toMatchObject({ status: 500, code: 'http_error' })
  })

  it('resolves absolute URLs for /api/... derived paths', () => {
    expect(apiUrl('/health')).toBe(`${API_BASE}/health`)
    expect(apiUrl('/api/assets/ast_1/proxy.mp4')).toBe(`${API_BASE}/assets/ast_1/proxy.mp4`)
    expect(apiUrl('http://x/y')).toBe('http://x/y')
  })
})
