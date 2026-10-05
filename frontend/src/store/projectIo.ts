// Загрузка проекта с бэка в store (сохранение/автосейв — фаза 8).
import { projectsApi } from '@/api/projects'
import { useAssets } from './assets'
import { useProject } from './project'
import { useUi } from './ui'

export async function openProject(id: string): Promise<void> {
  const project = await projectsApi.get(id)
  for (const a of project.assets) if (!useAssets.getState().assets[a.id]) useAssets.getState().upsertAsset(a)
  useProject.getState().load(project)
  useUi.setState({ selection: [], playhead: 0, scrollX: 0, scrollY: 0 })
}
