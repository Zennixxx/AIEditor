import { jobsApi } from '@/api/analysis'
import type { Job } from '@/shared/types.gen'
import { useAssets } from './assets'

export const JOB_POLL_MS = 750

export function waitForJob(jobId: string, onUpdate?: (job: Job) => void): Promise<Job> {
  return new Promise((resolve, reject) => {
    const cleanups: (() => void)[] = []
    let finished = false
    const finish = (fn: () => void) => {
      if (finished) return
      finished = true
      cleanups.forEach((c) => c())
      fn()
    }
    const handle = (job: Job | undefined) => {
      if (!job || job.id !== jobId || finished) return
      onUpdate?.(job)
      if (job.status === 'done') finish(() => resolve(job))
      else if (job.status === 'failed' || job.status === 'canceled')
        finish(() => reject(new Error(job.error?.message ?? 'Задача не выполнена')))
    }
    cleanups.push(
      useAssets.subscribe((s, prev) => {
        if (s.jobs[jobId] !== prev.jobs[jobId]) handle(s.jobs[jobId])
      }),
    )
    const timer = setInterval(() => {
      jobsApi.get(jobId).then(handle, () => undefined)
    }, JOB_POLL_MS)
    cleanups.push(() => clearInterval(timer))
    handle(useAssets.getState().jobs[jobId])
  })
}
