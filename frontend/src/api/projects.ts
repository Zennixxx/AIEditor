// Эндпоинты проектов (CONTRACT §8–9).
import type { CreateProjectRequest, Project, ProjectListItem } from '@/shared/types.gen'
import { api } from './client'

export const projectsApi = {
  list: () => api.get<ProjectListItem[]>('/projects'),
  get: (id: string) => api.get<Project>(`/projects/${id}`),
  create: (body: CreateProjectRequest) => api.post<Project>('/projects', body),
  save: (project: Project) => api.put<Project>(`/projects/${project.id}`, project),
  remove: (id: string) => api.del<void>(`/projects/${id}`),
}
