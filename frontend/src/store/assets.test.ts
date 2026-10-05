import { http, HttpResponse } from 'msw'
import { beforeEach, describe, expect, it } from 'vitest'
import { API_BASE } from '@/api/config'
import { fixtures } from '@/api/mocks/fixtures'
import { server } from '@/api/mocks/node'
import { activeJobs, useAssets } from './assets'

describe('assets store', () => {
  beforeEach(() => useAssets.setState({ assets: {}, order: [], jobs: {}, uploading: 0, error: null }))

  it('loads the library from GET /assets', async () => {
    await useAssets.getState().refresh()
    expect(useAssets.getState().order).toHaveLength(3)
  })

  it('uploads files via POST /assets/upload and adds importing assets', async () => {
    // jsdom-шный FormData не сериализуется node-fetch'ем в multipart — ответ мокаем без разбора тела
    // (сам MSW-хендлер upload проверяется e2e-тестом в браузере)
    let method = ''
    server.use(
      http.post(`${API_BASE}/assets/upload`, ({ request }) => {
        method = request.method
        const asset = {
          ...fixtures.assets[0]!,
          id: 'ast_up00000000000001',
          name: 'shot.mp4',
          status: 'importing' as const,
          derived: {},
        }
        return HttpResponse.json({ assets: [asset], jobs: [{ jobId: 'job_import0001' }] })
      }),
    )
    await useAssets.getState().upload([new File(['x'], 'shot.mp4', { type: 'video/mp4' })])
    const [id] = useAssets.getState().order
    const asset = useAssets.getState().assets[id!]!
    expect(asset).toMatchObject({ name: 'shot.mp4', kind: 'video', status: 'importing' })
    expect(useAssets.getState().uploading).toBe(0)
    expect(method).toBe('POST')
  })

  it('tracks running jobs per asset from WS events', () => {
    const now = new Date().toISOString()
    const job = {
      id: 'job_1',
      kind: 'proxy' as const,
      assetId: 'ast_1',
      progress: 0.5,
      createdAt: now,
      updatedAt: now,
    }
    useAssets.getState().upsertJob({ ...job, status: 'running' })
    expect(activeJobs(useAssets.getState().jobs, 'ast_1')).toHaveLength(1)
    useAssets.getState().upsertJob({ ...job, status: 'done', progress: 1 })
    expect(activeJobs(useAssets.getState().jobs, 'ast_1')).toHaveLength(0)
  })
})
