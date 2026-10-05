// Связка сторов с бэком: WS-события `asset`/`job` → библиотека ассетов и копии в проекте.
import { events } from '@/api/events'
import { useAssets } from './assets'
import { configureProjectStore, useProject } from './project'

/** Запускает синхронизацию; возвращает функцию остановки. */
export function startDataSync(): () => void {
  configureProjectStore({ resolveAsset: (id) => useAssets.getState().assets[id] })
  void useAssets.getState().refresh()

  const offAsset = events.on('asset', (e) => {
    useAssets.getState().upsertAsset(e.asset)
    useProject.getState().syncAsset(e.asset)
  })
  const offJob = events.on('job', (e) => useAssets.getState().upsertJob(e.job))
  const offStatus = events.onStatus((s) => {
    // после переподключения могли пропустить события — перечитываем список
    if (s === 'open') void useAssets.getState().refresh()
  })
  return () => {
    offAsset()
    offJob()
    offStatus()
  }
}
