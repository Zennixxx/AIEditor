// Адаптивные деления линейки: кадры → секунды → минуты.
import { formatTimecode } from '@/shared/time'

export interface RulerStep {
  /** Шаг подписанных делений, сек. */
  major: number
  /** Шаг мелких делений, сек. */
  minor: number
}

const SECOND_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600]
const MIN_MAJOR_PX = 90
const MIN_MINOR_PX = 7

export function rulerStep(pxPerSec: number, fps: number): RulerStep {
  const frame = 1 / fps
  const frameSteps = [1, 2, 5, 10].filter((n) => n < fps).map((n) => n * frame)
  const candidates = [...frameSteps, ...SECOND_STEPS]
  const major = candidates.find((s) => s * pxPerSec >= MIN_MAJOR_PX) ?? SECOND_STEPS[SECOND_STEPS.length - 1]!
  let minor = major
  for (const div of [10, 6, 5, 4, 2]) {
    const m = major / div
    const wholeFrames = Math.abs(m * fps - Math.round(m * fps)) < 1e-6 && m >= frame - 1e-9
    if (wholeFrames && m * pxPerSec >= MIN_MINOR_PX) {
      minor = m
      break
    }
  }
  return { major, minor }
}

export interface Tick {
  t: number
  major: boolean
  label?: string
}

/** Деления в видимом диапазоне [t0, t1]. */
export function rulerTicks(t0: number, t1: number, pxPerSec: number, fps: number): Tick[] {
  const { major, minor } = rulerStep(pxPerSec, fps)
  const ticks: Tick[] = []
  const start = Math.max(0, Math.floor(t0 / minor) * minor)
  const ratio = Math.round(major / minor)
  let i = Math.round(start / minor)
  for (let t = start; t <= t1 + minor; t = ++i * minor) {
    const isMajor = i % ratio === 0
    ticks.push(isMajor ? { t, major: true, label: formatTimecode(t, fps) } : { t, major: false })
    if (ticks.length > 5000) break
  }
  return ticks
}
