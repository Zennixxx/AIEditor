import { create } from 'zustand'
import { assetsApi } from '@/api/assets'
import { jobsApi } from '@/api/analysis'
import { ApiError } from '@/api/client'
import { coversClip, interpolationRange, requiredFactor, usableInterpolation } from '@/model/interpolation'
import { findClip } from '@/model/lookup'
import type { Asset, InterpolateRequest, Project } from '@/shared/types.gen'
import { useAssets } from './assets'
import { waitForJob } from './jobWait'
import { useProject } from './project'

export const INTERPOLATE_DEBOUNCE_MS = 1000

export interface ClipInterpolation {
  key: string
  jobId: string | null
  progress: number
  status: 'running' | 'failed'
  error?: string
}

interface InterpolationState {
  byClip: Record<string, ClipInterpolation>
}

export const useInterpolation = create<InterpolationState>()(() => ({ byClip: {} }))

function lookupFor(p: Pick<Project, 'assets'>): (id: string) => Asset | undefined {
  const lib = useAssets.getState().assets
  return (id) => lib[id] ?? p.assets.find((a) => a.id === id)
}

function patch(clipId: string, value: ClipInterpolation | null): void {
  useInterpolation.setState((s) => {
    const byClip = { ...s.byClip }
    if (value) byClip[clipId] = value
    else delete byClip[clipId]
    return { byClip }
  })
}

function current(clipId: string): ClipInterpolation | undefined {
  return useInterpolation.getState().byClip[clipId]
}

function cancelJob(entry: ClipInterpolation | undefined): void {
  if (entry?.status === 'running' && entry.jobId) void jobsApi.cancel(entry.jobId).catch(() => undefined)
}

function messageOf(e: unknown): string {
  return e instanceof ApiError || e instanceof Error ? e.message : 'Интерполяция не выполнена'
}

async function request(
  clipId: string,
  assetId: string,
  body: InterpolateRequest,
  key: string,
): Promise<void> {
  cancelJob(current(clipId))
  patch(clipId, { key, jobId: null, progress: 0, status: 'running' })
  try {
    const { jobId } = await assetsApi.interpolate(assetId, body)
    if (current(clipId)?.key !== key) return void jobsApi.cancel(jobId).catch(() => undefined)
    patch(clipId, { key, jobId, progress: 0, status: 'running' })
    const job = await waitForJob(jobId, (j) => {
      const e = current(clipId)
      if (e?.key === key && e.status === 'running') patch(clipId, { ...e, progress: j.progress })
    })
    const result = job.result as Asset | undefined
    if (!result?.id) throw new Error('Бэк не вернул ассет интерполяции')
    useAssets.getState().upsertAsset(result)
    if (current(clipId)?.key !== key) return
    const ref = findClip(useProject.getState().project, clipId)
    if (ref && !coversClip(result, ref.clip)) throw new Error('Интерполированный ассет не покрывает клип')
    patch(clipId, null)
    if (ref) useProject.getState().setInterpolated({ [clipId]: result.id })
  } catch (e) {
    if (current(clipId)?.key === key)
      patch(clipId, {
        key,
        jobId: current(clipId)?.jobId ?? null,
        progress: 0,
        status: 'failed',
        error: messageOf(e),
      })
  }
}

export function scanInterpolations(): void {
  const p = useProject.getState().project
  const lookup = lookupFor(p)
  const changes: Record<string, string | null> = {}
  const seen = new Set<string>()
  for (const track of p.tracks) {
    if (track.kind !== 'video') continue
    for (const clip of track.items) {
      if (clip.type !== 'clip') continue
      seen.add(clip.id)
      const asset = lookup(clip.assetId)
      const factor = requiredFactor(clip, asset, p.fps)
      const usable = usableInterpolation(clip, lookup)
      if (factor === null || !asset) {
        if (clip.interpolatedAssetId) changes[clip.id] = null
        cancelJob(current(clip.id))
        if (current(clip.id)) patch(clip.id, null)
        continue
      }
      if (!usable && clip.interpolatedAssetId) changes[clip.id] = null
      if (usable && (usable.parent?.factor ?? 0) >= factor) {
        cancelJob(current(clip.id))
        if (current(clip.id)) patch(clip.id, null)
        continue
      }
      const body = { ...interpolationRange(clip, asset), factor: factor as InterpolateRequest['factor'] }
      if (!(body.sourceIn < body.sourceOut)) continue
      const key = `${asset.id}|${body.sourceIn.toFixed(3)}|${body.sourceOut.toFixed(3)}|${factor}`
      if (current(clip.id)?.key === key) continue
      void request(clip.id, asset.id, body, key)
    }
  }
  for (const id of Object.keys(useInterpolation.getState().byClip)) {
    if (seen.has(id)) continue
    cancelJob(current(id))
    patch(id, null)
  }
  useProject.getState().setInterpolated(changes)
}

export function startInterpolationSync(delay = INTERPOLATE_DEBOUNCE_MS): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  const schedule = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      scanInterpolations()
    }, delay)
  }
  const unsubs = [
    useProject.subscribe((s, prev) => {
      if (s.project !== prev.project) schedule()
    }),
    useAssets.subscribe((s, prev) => {
      if (s.assets !== prev.assets) schedule()
    }),
  ]
  schedule()
  return () => {
    if (timer) clearTimeout(timer)
    unsubs.forEach((u) => u())
  }
}
