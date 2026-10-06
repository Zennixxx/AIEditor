// Связка сторов с бэком: WS-события `asset`/`job` → библиотека ассетов и копии в проекте.
import { events } from '@/api/events'
import type { Asset } from '@/shared/types.gen'
import { useAi } from './ai'
import { useAssets } from './assets'
import { useBackend } from './backend'
import { clipAnalysisOf, isClipAnalysis, useClipAnalysis } from './clipAnalysis'
import { configureProjectStore, useProject } from './project'

const autoRequested = new Set<string>()

const analyzable = (a: Asset) => a.kind === 'video' && !a.parent && a.status === 'ready'

/** Анализ готового видео: загрузить имеющийся, при включённом авто-анализе — запустить ИИ-анализ. */
function onVideoReady(asset: Asset): void {
  if (!analyzable(asset)) return
  void useClipAnalysis.getState().load(asset.id)
  if (!useAi.getState().autoAnalyze || !useBackend.getState().health?.gemini) return
  if (autoRequested.has(asset.id) || clipAnalysisOf(asset.id)?.model) return
  autoRequested.add(asset.id)
  void useClipAnalysis.getState().analyze(asset.id)
}

/** Запускает синхронизацию; возвращает функцию остановки. */
export function startDataSync(): () => void {
  configureProjectStore({
    resolveAsset: (id) => useAssets.getState().assets[id],
    clipAnalysis: clipAnalysisOf,
  })
  const loadAnalyses = () => {
    for (const a of Object.values(useAssets.getState().assets))
      if (analyzable(a)) void useClipAnalysis.getState().load(a.id)
  }
  void useAssets.getState().refresh().then(loadAnalyses)

  const offAsset = events.on('asset', (e) => {
    const before = useAssets.getState().assets[e.asset.id]
    useAssets.getState().upsertAsset(e.asset)
    useProject.getState().syncAsset(e.asset)
    if (before?.status !== 'ready') onVideoReady(e.asset)
  })
  const offJob = events.on('job', (e) => {
    useAssets.getState().upsertJob(e.job)
    if (e.job.kind === 'clipAnalysis' && e.job.status === 'done' && isClipAnalysis(e.job.result))
      useClipAnalysis.getState().put(e.job.result)
  })
  const offStatus = events.onStatus((s) => {
    // после переподключения могли пропустить события — перечитываем список
    if (s === 'open') void useAssets.getState().refresh().then(loadAnalyses)
  })
  return () => {
    offAsset()
    offJob()
    offStatus()
  }
}
