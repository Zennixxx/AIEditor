import type { Project } from '@/shared/types.gen'
import { api } from './client'

export const exportApi = {
  aeJsx: (project: Project, signal?: AbortSignal) => api.postBlob('/export/ae-jsx', project, signal),
}
