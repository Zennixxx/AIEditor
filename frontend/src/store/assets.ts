// Библиотека ассетов (Media Bin) и задачи бэка по WS.
import { create } from 'zustand'
import { assetsApi } from '@/api/assets'
import { ApiError } from '@/api/client'
import type { Asset, Job } from '@/shared/types.gen'

interface AssetsState {
  assets: Record<string, Asset>
  /** Порядок карточек (новые — в конце). */
  order: string[]
  jobs: Record<string, Job>
  uploading: number
  error: string | null
  refresh: () => Promise<void>
  upload: (files: readonly File[]) => Promise<void>
  upsertAsset: (asset: Asset) => void
  upsertJob: (job: Job) => void
}

export const useAssets = create<AssetsState>()((set, get) => ({
  assets: {},
  order: [],
  jobs: {},
  uploading: 0,
  error: null,

  refresh: async () => {
    try {
      const list = await assetsApi.list()
      for (const a of list) get().upsertAsset(a)
      set({ error: null })
    } catch (e) {
      set({ error: e instanceof ApiError ? e.message : 'Не удалось загрузить список ассетов' })
    }
  },

  upload: async (files) => {
    if (files.length === 0) return
    set((s) => ({ uploading: s.uploading + 1, error: null }))
    try {
      const res = await assetsApi.upload(files)
      for (const a of res.assets) get().upsertAsset(a)
    } catch (e) {
      set({ error: e instanceof ApiError ? e.message : 'Ошибка импорта' })
    } finally {
      set((s) => ({ uploading: s.uploading - 1 }))
    }
  },

  upsertAsset: (asset) =>
    set((s) => ({
      assets: { ...s.assets, [asset.id]: asset },
      order: s.order.includes(asset.id) ? s.order : [...s.order, asset.id],
    })),

  upsertJob: (job) => set((s) => ({ jobs: { ...s.jobs, [job.id]: job } })),
}))

/** Незавершённые задачи ассета (для прогресса на карточке). */
export function activeJobs(jobs: Record<string, Job>, assetId: string): Job[] {
  return Object.values(jobs).filter(
    (j) => j.assetId === assetId && (j.status === 'queued' || j.status === 'running'),
  )
}

export function failedJobs(jobs: Record<string, Job>, assetId: string): Job[] {
  return Object.values(jobs).filter((j) => j.assetId === assetId && j.status === 'failed')
}
