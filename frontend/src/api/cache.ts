// Очистка кэша бэка (CONTRACT §8.8).
import type { CacheCleanupResult } from '@/shared/types.gen'
import { api } from './client'

export const cacheApi = {
  clean: (olderThanDays: number) => api.del<CacheCleanupResult>(`/cache?olderThanDays=${olderThanDays}`),
}
