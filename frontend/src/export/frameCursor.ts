import { FRAME_EPS } from '@/shared/time'

export interface TimedSample {
  readonly timestamp: number
  close(): void
}

export interface SampleSource<S extends TimedSample> {
  samples(startTimestamp: number): AsyncGenerator<S, void, unknown>
  getSample(timestamp: number): Promise<S | null>
}

export const MAX_FORWARD_GAP = 3

export class FrameCursor<S extends TimedSample> {
  private iter: AsyncGenerator<S, void, unknown> | null = null
  private cur: S | null = null
  private next: S | null = null
  private ended = false
  restarts = 0

  constructor(private readonly source: SampleSource<S>) {}

  async at(t: number): Promise<S | null> {
    const cur = this.cur
    if (!cur || t < cur.timestamp - FRAME_EPS || t > cur.timestamp + MAX_FORWARD_GAP) await this.restart(t)
    for (;;) {
      if (!this.next && !this.ended && this.iter) {
        const r = await this.iter.next()
        if (r.done) this.ended = true
        else this.next = r.value
      }
      if (!this.next || this.next.timestamp > t + FRAME_EPS) break
      this.cur?.close()
      this.cur = this.next
      this.next = null
    }
    return this.cur
  }

  async following(): Promise<S | null> {
    if (!this.next && !this.ended && this.iter) {
      const r = await this.iter.next()
      if (r.done) this.ended = true
      else this.next = r.value
    }
    return this.next
  }

  private async restart(t: number): Promise<void> {
    await this.dispose()
    this.restarts++
    this.iter = this.source.samples(Math.max(0, t))
    const first = await this.iter.next()
    if (first.done) {
      this.ended = true
      this.cur = await this.source.getSample(t)
      return
    }
    if (first.value.timestamp > t + FRAME_EPS) {
      const exact = await this.source.getSample(t)
      if (exact) {
        this.cur = exact
        this.next = first.value
        return
      }
    }
    this.cur = first.value
  }

  async dispose(): Promise<void> {
    this.cur?.close()
    this.next?.close()
    this.cur = null
    this.next = null
    this.ended = false
    const iter = this.iter
    this.iter = null
    if (iter) await iter.return(undefined)
  }
}
