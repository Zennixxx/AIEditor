// MSW-моки API бэка (CONTRACT §8) поверх shared/fixtures.
// Долгие операции имитируются задачами с прогрессом через WS-события.
import { delay, http, HttpResponse, ws } from 'msw'
import type {
  Asset,
  CreateEffectPresetRequest,
  EffectPreset,
  ImportResponse,
  Job,
  JobKind,
  MusicAnalysis,
  MusicAnalysisParams,
  MusicAnalysisParamsInput,
  Project,
  ProjectListItem,
  StylePreset,
  Thumbs,
  Waveform,
  WsEvent,
} from '@/shared/types.gen'
import { paramErrors } from '@/shared/effects-registry'
import { newId } from '@/shared/ids'
import { API_BASE, WS_URL } from '../config'
import { clone, fixtures } from './fixtures'
import { encodeWav, mockAudio, mockProxy, rangeResponse, waveformOf } from './media'

/** Музыкальный ассет фикстур — его waveform лежит в shared/fixtures/waveform_music.json. */
const FIXTURE_MUSIC_ID = 'ast_c0ffee1234abcd56'

const url = (path: string) => API_BASE + path
const events = ws.link(WS_URL)

const assets = new Map<string, Asset>(fixtures.assets.map((a) => [a.id, clone(a)]))
const projects = new Map<string, Project>([[fixtures.project.id, clone(fixtures.project)]])
const presets: EffectPreset[] = clone(fixtures.presets)
const userStyles: StylePreset[] = []
const jobs = new Map<string, Job>(fixtures.jobs.map((j) => [j.id, clone(j)]))
const timers = new Map<string, ReturnType<typeof setInterval>>()
/** Готовые анализы музыки по assetId (GET /analysis/music/{id}); демо-ассет фикстур считается проанализированным. */
const musicAnalyses = new Map<string, MusicAnalysis>([
  [fixtures.musicAnalysis.assetId, clone(fixtures.musicAnalysis)],
])

const DEFAULT_MUSIC_PARAMS: MusicAnalysisParams = {
  bassCutoffHz: 150,
  sensitivity: 0.5,
  minGapSec: 0.12,
  useStems: false,
}

/**
 * «Анализ» в моке: результат фикстуры, а параметры влияют на басы — sensitivity выше → больше слабых басов,
 * minGapSec отсекает близкие (жадно, по порядку). Остальные списки (beats, onsets, sections) — как в фикстуре.
 */
function mockMusicAnalysis(assetId: string, input: MusicAnalysisParamsInput): MusicAnalysis {
  const params: MusicAnalysisParams = { ...DEFAULT_MUSIC_PARAMS, ...input }
  const base = clone(fixtures.musicAnalysis)
  const minStrength = Math.max(0, 0.5 - params.sensitivity)
  let last = -Infinity
  const bass = base.bass.filter((b) => {
    if (b.strength < minStrength || b.t - last < params.minGapSec) return false
    last = b.t
    return true
  })
  return { ...base, assetId, params, bass }
}

function broadcast(event: WsEvent): void {
  events.broadcast(JSON.stringify(event))
}

function notFound(code: string, message: string) {
  return HttpResponse.json({ error: { code, message } }, { status: 404 })
}

function registerJob(kind: JobKind, assetId?: string): Job {
  const now = new Date().toISOString()
  const job: Job = { id: newId('job'), kind, status: 'queued', progress: 0, createdAt: now, updatedAt: now }
  if (assetId) job.assetId = assetId
  jobs.set(job.id, job)
  broadcast({ type: 'job', job: clone(job) })
  return job
}

/** Прогресс задачи по таймеру; по завершении — result/onDone и WS-событие. */
function driveJob(
  job: Job,
  opts: { durationMs?: number; result?: () => unknown; onDone?: () => void } = {},
): void {
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
}

function runJob(
  kind: JobKind,
  opts: { assetId?: string; durationMs?: number; result?: () => unknown; onDone?: () => void } = {},
): Job {
  const job = registerJob(kind, opts.assetId)
  driveJob(job, opts)
  return job
}

interface ChainStep {
  kind: JobKind
  durationMs: number
  onDone: () => void
}

/**
 * Цепочка производных файлов (CONTRACT §8.1): все задачи регистрируются сразу (queued), выполняются
 * по очереди; после последней ассет становится `ready` (WS `asset`). Задачи kind `import` нет.
 */
function runChain(assetId: string, steps: ChainStep[], onFinish: () => void): Job[] {
  const registered = steps.map((st) => ({ st, job: registerJob(st.kind, assetId) }))
  const next = (i: number) => {
    const cur = registered[i]
    if (!cur) return onFinish()
    driveJob(cur.job, {
      durationMs: cur.st.durationMs,
      onDone: () => {
        cur.st.onDone()
        next(i + 1)
      },
    })
  }
  next(0)
  return registered.map((r) => r.job)
}

function importAsset(name: string, path: string): { asset: Asset; jobs: Job[] } {
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
    status: isImage ? 'ready' : 'importing',
    derived: {},
    ...(isAudio ? {} : isImage ? { width: 1920, height: 1080 } : { width: 1920, height: 1080, fps: 30 }),
  }
  assets.set(id, asset)
  if (isImage) return { asset: clone(asset), jobs: [] } // изображения сразу ready, без задач
  const publish = (derived: Partial<Asset['derived']>) => {
    asset.derived = { ...asset.derived, ...derived }
    broadcast({ type: 'asset', asset: clone(asset) })
  }
  const steps: ChainStep[] = isAudio
    ? [
        { kind: 'audio', durationMs: 700, onDone: () => publish({ audio: `${base}/audio.m4a` }) },
        { kind: 'waveform', durationMs: 600, onDone: () => publish({ waveform: `${base}/waveform.json` }) },
      ]
    : [
        { kind: 'proxy', durationMs: 1200, onDone: () => publish({ proxy: `${base}/proxy.mp4` }) },
        { kind: 'thumbs', durationMs: 600, onDone: () => publish({ thumbs: `${base}/thumbs.json` }) },
        { kind: 'audio', durationMs: 400, onDone: () => publish({ audio: `${base}/audio.m4a` }) },
        { kind: 'waveform', durationMs: 400, onDone: () => publish({ waveform: `${base}/waveform.json` }) },
      ]
  const chain = runChain(id, steps, () => {
    // готовность — по наличию основного файла: proxy у видео, audio.m4a у аудио
    asset.status = (isAudio ? asset.derived.audio : asset.derived.proxy) ? 'ready' : 'failed'
    publish({})
  })
  return { asset: clone(asset), jobs: chain.map(clone) }
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
    rows: ATLAS_COLUMNS,
    count,
    sprites: Array.from(
      { length: Math.ceil(count / per) },
      (_, i) => `/api/assets/${asset.id}/thumbs/${i}.jpg`,
    ),
  }
}

function importResponse(res: { asset: Asset; jobs: Job[] }[]): ImportResponse {
  return { assets: res.map((r) => r.asset), jobs: res.flatMap((r) => r.jobs.map((j) => ({ jobId: j.id }))) }
}

/** Waveform фикстуры — для музыкального демо-ассета, для остальных — по синтетическому звуку (256 сэмплов/пик). */
function waveformFor(asset: Asset): Waveform {
  if (asset.id === FIXTURE_MUSIC_ID) return fixtures.waveform
  return waveformOf(mockAudio(asset.id, Math.max(asset.duration, 0.1)))
}

/** Картинка-«оригинал» для импортированного изображения. */
async function renderStill(asset: Asset): Promise<Blob | null> {
  if (typeof OffscreenCanvas === 'undefined') return null
  const canvas = new OffscreenCanvas(asset.width ?? 1920, asset.height ?? 1080)
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  const g = ctx.createRadialGradient(
    canvas.width / 2,
    canvas.height / 2,
    10,
    canvas.width / 2,
    canvas.height / 2,
    canvas.width / 2,
  )
  g.addColorStop(0, '#f5b942')
  g.addColorStop(1, '#3a2a6c')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.fillStyle = '#fff'
  ctx.font = 'bold 96px sans-serif'
  ctx.fillText(asset.name, 80, canvas.height / 2)
  return canvas.convertToBlob({ type: 'image/png' })
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
  http.get(url('/assets/:id/waveform.json'), ({ params }) => {
    const a = assets.get(String(params.id))
    if (!a) return notFound('asset_not_found', `Ассет ${String(params.id)} не найден`)
    return HttpResponse.json(waveformFor(a))
  }),
  // proxy.mp4 / audio.m4a — с поддержкой Range (206), как FileResponse на бэке
  http.get(url('/assets/:id/proxy.mp4'), async ({ params, request }) => {
    const a = assets.get(String(params.id))
    if (!a) return notFound('asset_not_found', `Ассет ${String(params.id)} не найден`)
    if (a.kind !== 'video' || !a.derived.proxy) return notFound('file_not_found', 'Прокси ещё не готов')
    const blob = await mockProxy(a.id, a.name, a.duration)
    return blob
      ? rangeResponse(new Uint8Array(await blob.arrayBuffer()), request, blob.type)
      : notFound('file_not_found', 'Прокси недоступен')
  }),
  http.get(url('/assets/:id/audio.m4a'), ({ params, request }) => {
    const a = assets.get(String(params.id))
    if (!a) return notFound('asset_not_found', `Ассет ${String(params.id)} не найден`)
    if (!a.derived.audio) return notFound('file_not_found', 'Звук ещё не извлечён')
    // m4a в моке — на деле WAV: decodeAudioData определяет формат по содержимому
    return rangeResponse(new Uint8Array(encodeWav(mockAudio(a.id, a.duration))), request, 'audio/wav')
  }),
  http.get(url('/assets/:id/original'), async ({ params, request }) => {
    const a = assets.get(String(params.id))
    if (!a) return notFound('asset_not_found', `Ассет ${String(params.id)} не найден`)
    if (a.kind === 'video') {
      const video = await mockProxy(a.id, a.name, a.duration)
      return video
        ? rangeResponse(new Uint8Array(await video.arrayBuffer()), request, video.type)
        : notFound('file_not_found', 'Оригинал недоступен в моке')
    }
    const blob = a.kind === 'image' ? await renderStill(a) : null
    return blob
      ? new HttpResponse(blob, { headers: { 'Content-Type': 'image/png' } })
      : notFound('file_not_found', 'Оригинал недоступен в моке')
  }),
  http.get(url('/assets/:id/mezzanine.mp4'), async ({ params, request }) => {
    const a = assets.get(String(params.id))
    if (!a) return notFound('asset_not_found', `Ассет ${String(params.id)} не найден`)
    const video = a.kind === 'video' && a.derived.mezzanine ? await mockProxy(a.id, a.name, a.duration) : null
    return video
      ? rangeResponse(new Uint8Array(await video.arrayBuffer()), request, video.type)
      : notFound('file_not_found', 'Mezzanine не готов')
  }),
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
    return HttpResponse.json(importResponse(res))
  }),
  http.post(url('/assets/upload'), async ({ request }) => {
    const form = await request.formData()
    const files = form.getAll('files').filter((f): f is File => f instanceof File)
    const res = files.map((f) => importAsset(f.name, `D:\\uploads\\${f.name}`))
    return HttpResponse.json(importResponse(res))
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
          parent: { assetId: parentId, kind: 'interpolated', ...body, quality: 'rife' },
        }
        assets.set(derived.id, derived)
        return derived
      },
    })
    return HttpResponse.json({ jobId: job.id })
  }),

  // --- анализ ---
  http.get(url('/analysis/music/:id'), ({ params }) => {
    const found = musicAnalyses.get(String(params.id))
    return found ? HttpResponse.json(found) : notFound('analysis_not_found', 'Анализ ещё не выполнен')
  }),
  http.post(url('/analysis/music/:id'), async ({ params, request }) => {
    const assetId = String(params.id)
    if (!assets.has(assetId)) return notFound('asset_not_found', `Ассет ${assetId} не найден`)
    const body = ((await request.json().catch(() => ({}))) ?? {}) as MusicAnalysisParamsInput
    // прогресс по WS (kind musicAnalysis), по завершении результат кладётся и в job.result, и в GET /analysis/music/{id}
    const job = runJob('musicAnalysis', {
      assetId,
      durationMs: 1600,
      result: () => {
        const analysis = mockMusicAnalysis(assetId, body)
        musicAnalyses.set(assetId, analysis)
        return analysis
      },
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

  http.get(url('/presets'), () => HttpResponse.json(presets)),
  http.post(url('/presets'), async ({ request }) => {
    const body = (await request.json()) as CreateEffectPresetRequest
    const errors = body.effects.flatMap((e, i) =>
      paramErrors(e.effect, e.params).map((m) => `effects[${i}]: ${m}`),
    )
    if (errors.length > 0) {
      return HttpResponse.json(
        {
          error: {
            code: 'invalid_preset',
            message: 'Пресет не соответствует реестру эффектов',
            details: { errors },
          },
        },
        { status: 422 },
      )
    }
    const preset: EffectPreset = { ...body, id: newId('pst') }
    presets.push(preset)
    return HttpResponse.json(preset)
  }),

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
  http.post(url('/ai/analyze-music/:id'), ({ params }) => {
    const assetId = String(params.id)
    const base = musicAnalyses.get(assetId) ?? { ...clone(fixtures.musicAnalysis), assetId }
    const job = runJob('aiMusic', {
      assetId,
      durationMs: 1500,
      result: () => {
        const enriched: MusicAnalysis = {
          ...base,
          sections: base.sections.map((s) => ({ ...s, description: `ИИ: ${s.label}` })),
        }
        musicAnalyses.set(assetId, enriched)
        return enriched
      },
    })
    return HttpResponse.json({ jobId: job.id })
  }),
  http.post(url('/ai/command'), async () => {
    await delay(700)
    return HttpResponse.json(fixtures.opsResult)
  }),
  http.post(url('/ai/style-from-reference/:id'), ({ params }) => {
    const assetId = String(params.id)
    const job = runJob('styleRef', {
      assetId,
      durationMs: 1500,
      result: () => {
        const style: StylePreset = {
          ...clone(fixtures.styles[0]!),
          id: `ref_${assetId.replace(/^ast_/, '')}`,
          name: `Стиль: ${assets.get(assetId)?.name ?? assetId}`,
        }
        userStyles.splice(0, userStyles.length, ...userStyles.filter((x) => x.id !== style.id), style)
        return style
      },
    })
    return HttpResponse.json({ jobId: job.id })
  }),
  http.get(url('/presets/styles'), () => HttpResponse.json(userStyles)),
  http.post(url('/ai/auto-edit'), () => {
    const job = runJob('autoEdit', { durationMs: 5000, result: () => clone(fixtures.opsResult) })
    return HttpResponse.json({ jobId: job.id })
  }),

  // --- задачи ---
  http.post(url('/export/ae-jsx'), async ({ request }) => {
    const project = (await request.json()) as Project
    const script = `// AIEditor -> After Effects (mock)
var DATA = ${JSON.stringify({ comp: { name: project.name } })};
`
    return new HttpResponse(script, {
      headers: {
        'Content-Type': 'text/javascript; charset=utf-8',
        'Content-Disposition': 'attachment; filename="project.jsx"',
      },
    })
  }),

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
