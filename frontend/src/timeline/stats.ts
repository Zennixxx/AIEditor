// Замер отрисовки таймлайна (dev, e2e perf): число кадров и время drawTimeline.
export const timelineStats = {
  draws: 0,
  totalMs: 0,
  maxMs: 0,
  samples: [] as number[],
  reset(): void {
    this.draws = 0
    this.totalMs = 0
    this.maxMs = 0
    this.samples = []
  },
  record(ms: number): void {
    this.draws++
    this.totalMs += ms
    this.maxMs = Math.max(this.maxMs, ms)
    if (this.samples.length < 10_000) this.samples.push(ms)
  },
}
