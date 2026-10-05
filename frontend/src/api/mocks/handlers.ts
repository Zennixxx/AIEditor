// MSW-моки API бэка (CONTRACT §8) поверх shared/fixtures.
// Долгие операции имитируются задачами с прогрессом через WS-события.
import { delay, http, HttpResponse, ws } from 'msw'
import type { Asset, Job, JobKind, Project, ProjectListItem, Thumbs, WsEvent } from '@/shared/types.gen'
import { newId } from '@/shared/ids'
import { API_BASE, WS_URL } from '../config'
import { clone, fixtures } from './fixtures'

const url = (path: string) => API_BASE + path
const events = ws.link(WS_URL)

const assets = new Map<string, Asset>(fixtures.assets.map((a) => [a.id, clone(a)]))
const projects = new Map<string, Project>([[fixtures.project.id, clone(fixtures.project)]])
const jobs = new Map<string, Job>(fixtures.jobs.map((j) => [j.id, clone(j)]))
const timers = new Map<string, ReturnType<typeof setInterval>>()

function broadcast(event: WsEvent): void {
  events.broadcast(JSON.stringify(event))
}

function notFound(code: string, message: string) {
  return HttpResponse.json({ error: { code, message } }, { status: 404 })
}

function runJob(
  kind: JobKind,
  opts: { assetId?: string; durationMs?: number; result?: () => unknown; onDone?: () => void } = {},
): Job {
  const now = new Date().toISOString()
  const job: Job = { id: newId('job'), kind, status: 'queued', progress: 0, createdAt: now, updatedAt: now }
  if (opts.assetId) job.assetId = opts.assetId
  jobs.set(job.id, job)
  broadcast({ type: 'job', job: clone(job) })

  const steps = 8
  let step = 0
  const timer = setInterval(
    () => {
      step += 1
      job.updatedAt = new Date().toISOString()
      if (step < steps) {
        job.status = 'running'
        job.progress = step / steps
      } else {
        clearInterval(timer)
        timers.delete(job.id)
        job.status = 'done'
        job.progress = 1
        job.result = opts.result?.()
        opts.onDone?.()
      }
      broadcast({ type: 'job', job: clone(job) })
    },
    (opts.durationMs ?? 1500) / steps,
  )
  timers.set(job.id, timer)
  return job
}

/** Задачи по цепочке (как на бэке, docs/BACKEND.md): каждая следующая стартует после предыдущей. */
function runChain(steps: { kind: JobKind; durationMs: number; onDone: () => void }[], assetId: string): void {
  const [first, ...rest] = steps
  if (!first) return
  runJob(first.kind, {
    assetId,
    durationMs: first.durationMs,
    onDone: () => {
      first.onDone()
      runChain(rest, assetId)
    },
  })
}

function importAsset(name: string, path: string): { asset: Asset; job: Job } {
  const isAudio = /\.(mp3|wav|m4a|flac|ogg|aac)$/i.test(name)
  const isImage = /\.(png|jpe?g|webp|gif|bmp)$/i.test(name)
  const id = 'ast_' + newId('x', 16).slice(2)
  const base = `/api/assets/${id}`
  const asset: Asset = {
    id,
    kind: isAudio ? 'audio' : isImage ? 'image' : 'video',
    name,
    path,
    duration: isAudio ? 96 : isImage ? 0 : 10,
    hasAudio: !isImage,
    codec: isAudio ? 'mp3' : isImage ? 'png' : 'h264',
    browserDecodable: true,
    status: 'importing',
    derived: {},
    ...(isAudio ? {} : isImage ? { width: 1920, height: 1080 } : { width: 1920, height: 1080, fps: 30 }),
  }
  assets.set(id, asset)
  const publish = (derived: Partial<Asset['derived']>) => {
    asset.derived = { ...asset.derived, ...derived }
    broadcast({ type: 'asset', asset: clone(asset) })
  }
  const chain: Parameters<typeof runChain>[0] = isAudio
    ? [
        {
          kind: 'waveform',
          durationMs: 800,
          onDone: () => publish({ audio: `${base}/audio.m4a`, waveform: `${base}/waveform.json` }),
        },
      ]
    : isImage
      ? []
      : [
          {
            kind: 'proxy',
            durationMs: 1500,
            onDone: () => publish({ proxy: `${base}/proxy.mp4`, audio: `${base}/audio.m4a` }),
          },
          { kind: 'thumbs', durationMs: 800, onDone: () => publish({ thumbs: `${base}/thumbs.json` }) },
          { kind: 'waveform', durationMs: 600, onDone: () => publish({ waveform: `${base}/waveform.json` }) },
        ]
  // import = ffprobe: после него известны длительность и параметры, ассет готов к работе
  const job = runJob('import', {
    assetId: id,
    durationMs: 600,
    result: () => clone(asset),
    onDone: () => {
      asset.status = 'ready'
      publish({})
      runChain(chain, id)
    },
  })
  return { asset: clone(asset), job }
}

const TILE_W = 160
const TILE_H = 90
const ATLAS_COLUMNS = 10

/** thumbs.json для ассета: фикстура для демо-ассета, для остальных — 1 кадр/с, атласы 10×10. */
function thumbsFor(asset: Asset): Thumbs {
  if (fixtures.thumbs.sprites[0]?.includes(asset.id)) return fixtures.thumbs
  const count = Math.max(1, Math.ceil(asset.duration))
  const per = ATLAS_COLUMNS * ATLAS_COLUMNS
  return {
    interval: 1,
    tileWidth: TILE_W,
    tileHeight: TILE_H,
    columns: ATLAS_COLUMNS,
    count,
    sprites: Array.from(
      { length: Math.ceil(count / per) },
      (_, i) => `/api/assets/${asset.id}/thumbs/${i}.jpg`,
    ),
  }
}

/** Синтетический JPG-атлас: цветные плитки с номером кадра (только в браузере — нужен OffscreenCanvas). */
async function renderAtlas(assetId: string, sprite: number): Promise<Blob | null> {
  if (typeof OffscreenCanvas === 'undefined') return null
  const canvas = new OffscreenCanvas(TILE_W * ATLAS_COLUMNS, TILE_H * ATLAS_COLUMNS)
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  let hash = 0
  for (const ch of assetId) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
  for (let i = 0; i < ATLAS_COLUMNS * ATLAS_COLUMNS; i++) {
    const index = sprite * ATLAS_COLUMNS * ATLAS_COLUMNS + i
    const x = (i % ATLAS_COLUMNS) * TILE_W
    const y = Math.floor(i / ATLAS_COLUMNS) * TILE_H
    const hue = (hash + index * 23) % 360
    const g = ctx.createLinearGradient(x, y, x + TILE_W, y + TILE_H)
    g.addColorStop(0, `hsl(${hue} 55% 38%)`)
    g.addColorStop(1, `hsl(${(hue + 40) % 360} 60% 18%)`)
    ctx.fillStyle = g
    ctx.fillRect(x, y, TILE_W, TILE_H)
    ctx.fillStyle = 'rgba(255,255,255,0.85)'
    ctx.font = 'bold 28px sans-serif'
    ctx.fillText(`${index}s`, x + 12, y + 52)
  }
  return canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 })
}

export const handlers = [
  events.addEventListener('connection', ({ client }) => {
    const hello: WsEvent = { type: 'hello', version: fixtures.health.version, schemaVersion: 1 }
    client.send(JSON.stringify(hello))
  }),

  http.get(url('/health'), () => HttpResponse.json(fixtures.health)),

  // --- ассеты ---
  http.get(url('/assets'), () => HttpResponse.json([...assets.values()])),
  http.get(url('/assets/:id'), ({ params }) => {
    const a = assets.get(String(params.id))
    return a ? HttpResponse.json(a) : notFound('asset_not_found', `Ассет ${String(params.id)} не найден`)
  }),
  http.get(url('/assets/:id/waveform.json'), () => HttpResponse.json(fixtures.waveform)),
  http.get(url('/assets/:id/thumbs.json'), ({ params }) => {
    const a = assets.get(String(params.id))
    return a
      ? HttpResponse.json(thumbsFor(a))
      : notFound('asset_not_found', `Ассет ${String(params.id)} не найден`)
  }),
  http.get(url('/assets/:id/thumbs/:file'), async ({ params }) => {
    const blob = await renderAtlas(String(params.id), parseInt(String(params.file), 10) || 0)
    return blob
      ? new HttpResponse(blob, { headers: { 'Content-Type': 'image/jpeg' } })
      : notFound('file_not_found', 'Атлас недоступен')
  }),
  http.post(url('/assets/import'), async ({ request }) => {
    const body = (await request.json()) as { paths: string[] }
    const res = body.paths.map((p) => importAsset(p.split(/[\\/]/).pop() ?? p, p))
    return HttpResponse.json({ assets: res.map((r) => r.asset), jobs: res.map((r) => ({ jobId: r.job.id })) })
  }),
  http.post(url('/assets/upload'), async ({ request }) => {
    const form = await request.formData()
    const files = form.getAll('files').filter((f): f is File => f instanceof File)
    const res = files.map((f) => importAsset(f.name, `D:\\uploads\\${f.name}`))
    return HttpResponse.json({ assets: res.map((r) => r.asset), jobs: res.map((r) => ({ jobId: r.job.id })) })
  }),
  http.post(url('/assets/:id/interpolate'), async ({ params, request }) => {
    const parentId = String(params.id)
    const parent = assets.get(parentId)
    if (!parent) return notFound('asset_not_found', `Ассет ${parentId} не найден`)
    const body = (await request.json()) as { sourceIn: number; sourceOut: number; factor: number }
    const job = runJob('interpolate', {
      assetId: parentId,
      durationMs: 3000,
      result: () => {
        const derived: Asset = {
          ...clone(parent),
          id: 'ast_' + newId('x', 16).slice(2),
          name: `${parent.name} ×${body.factor}`,
          fps: (parent.fps ?? 30) * body.factor,
          parent: { assetId: parentId, kind: 'interpolated', ...body },
        }
        assets.set(derived.id, derived)
        return derived
      },
    })
    return HttpResponse.json({ jobId: job.id })
  }),

  // --- анализ ---
  http.get(url('/analysis/music/:id'), ({ params }) =>
    params.id === fixtures.musicAnalysis.assetId
      ? HttpResponse.json(fixtures.musicAnalysis)
      : notFound('analysis_not_found', 'Анализ ещё не выполнен'),
  ),
  http.post(url('/analysis/music/:id'), ({ params }) => {
    const assetId = String(params.id)
    const job = runJob('musicAnalysis', {
      assetId,
      durationMs: 2000,
      result: () => ({ ...clone(fixtures.musicAnalysis), assetId }),
    })
    return HttpResponse.json({ jobId: job.id })
  }),
  http.get(url('/analysis/clip/:id'), ({ params }) =>
    params.id === fixtures.clipAnalysis.assetId
      ? HttpResponse.json(fixtures.clipAnalysis)
      : notFound('analysis_not_found', 'Анализ ещё не выполнен'),
  ),

  // --- проекты ---
  http.get(url('/projects'), () =>
    HttpResponse.json(
      [...projects.values()].map((p): ProjectListItem => ({
        id: p.id,
        name: p.name,
        updatedAt: p.updatedAt,
      })),
    ),
  ),
  http.post(url('/projects'), async ({ request }) => {
    const body = (await request.json()) as Pick<Project, 'name' | 'fps' | 'width' | 'height'>
    const now = new Date().toISOString()
    const p: Project = {
      schemaVersion: 1,
      id: newId('prj'),
      ...body,
      duration: 0,
      background: '#000000',
      assets: [],
      tracks: [],
      markers: [],
      sections: [],
      createdAt: now,
      updatedAt: now,
      revision: 0,
    }
    projects.set(p.id, p)
    return HttpResponse.json(p)
  }),
  http.get(url('/projects/:id'), ({ params }) => {
    const p = projects.get(String(params.id))
    return p ? HttpResponse.json(p) : notFound('project_not_found', 'Проект не найден')
  }),
  http.put(url('/projects/:id'), async ({ params, request }) => {
    const current = projects.get(String(params.id))
    if (!current) return notFound('project_not_found', 'Проект не найден')
    const body = (await request.json()) as Project
    if (body.revision !== current.revision) {
      return HttpResponse.json(
        { error: { code: 'revision_conflict', message: 'Проект изменён в другом окне' } },
        { status: 409 },
      )
    }
    const saved: Project = { ...body, revision: body.revision + 1, updatedAt: new Date().toISOString() }
    projects.set(saved.id, saved)
    return HttpResponse.json(saved)
  }),

  http.get(url('/presets'), () => HttpResponse.json([])),

  // --- ИИ ---
  http.post(url('/ai/analyze-clip/:id'), ({ params }) => {
    const assetId = String(params.id)
    const job = runJob('clipAnalysis', {
      assetId,
      durationMs: 4000,
      result: () => ({ ...clone(fixtures.clipAnalysis), assetId }),
    })
    return HttpResponse.json({ jobId: job.id })
  }),
  http.post(url('/ai/command'), async () => {
    await delay(700)
    return HttpResponse.json(fixtures.opsResult)
  }),
  http.post(url('/ai/auto-edit'), () => {
    const job = runJob('autoEdit', { durationMs: 5000, result: () => clone(fixtures.opsResult) })
    return HttpResponse.json({ jobId: job.id })
  }),

  // --- задачи ---
  http.get(url('/jobs/:id'), ({ params }) => {
    const j = jobs.get(String(params.id))
    return j ? HttpResponse.json(j) : notFound('job_not_found', `Задача ${String(params.id)} не найдена`)
  }),
  http.delete(url('/jobs/:id'), ({ params }) => {
    const id = String(params.id)
    const j = jobs.get(id)
    if (!j) return notFound('job_not_found', `Задача ${id} не найдена`)
    const timer = timers.get(id)
    if (timer) {
      clearInterval(timer)
      timers.delete(id)
      j.status = 'canceled'
      j.updatedAt = new Date().toISOString()
      broadcast({ type: 'job', job: clone(j) })
    }
    return HttpResponse.json(j)
  }),
]
