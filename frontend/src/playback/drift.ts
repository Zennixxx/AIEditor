// Синхронизация <video> с мастер-часами и определение быстрого скраба. Чистые функции.

/** Порог жёсткой коррекции: дальше — seek (docs/FRONTEND.md 1.5). */
export const SEEK_THRESHOLD = 0.1
/** Предел мягкой подстройки playbackRate (±). */
export const MAX_NUDGE = 0.25
/** Диапазон playbackRate, который браузеры гарантированно поддерживают. */
export const MIN_VIDEO_RATE = 0.0625
export const MAX_VIDEO_RATE = 16

export type DriftAction =
  { kind: 'ok'; rate: number } | { kind: 'nudge'; rate: number } | { kind: 'seek'; to: number; rate: number }

/**
 * Коррекция дрейфа видео относительно мастер-часов.
 * - расхождение ≤ 1 кадра — ничего не делаем;
 * - > 1 кадра — плавно правим позицию через playbackRate (догнать/подождать без рывка seek);
 * - > 0.1 с — seek в ожидаемую позицию.
 * `rate` — номинальная скорость чтения исходника (> 0), `fps` — кадровая частота проекта.
 */
export function correctDrift(actual: number, expected: number, rate: number, fps: number): DriftAction {
  const diff = expected - actual // > 0 — видео отстаёт
  const base = clampVideoRate(rate)
  if (Math.abs(diff) > SEEK_THRESHOLD) return { kind: 'seek', to: expected, rate: base }
  if (Math.abs(diff) > 1 / fps) {
    // догнать за ~0.5 с: rate · (1 + 2·diff/rate), не больше ±25%
    const k = Math.max(-MAX_NUDGE, Math.min(MAX_NUDGE, (2 * diff) / Math.max(rate, 1e-3)))
    return { kind: 'nudge', rate: clampVideoRate(rate * (1 + k)) }
  }
  return { kind: 'ok', rate: base }
}

export function clampVideoRate(rate: number): number {
  return Math.min(MAX_VIDEO_RATE, Math.max(MIN_VIDEO_RATE, rate))
}

/** Можно ли играть видео нативно (а не seek-ом по кадрам): вперёд и в поддерживаемом диапазоне. */
export function canPlayNatively(rate: number): boolean {
  return rate >= MIN_VIDEO_RATE && rate <= MAX_VIDEO_RATE
}

/** Видео уже показывает кадр `target` (точность — полкадра). */
export function onFrame(current: number, target: number, fps: number): boolean {
  return Math.abs(current - target) <= 0.5 / fps
}

/** Окно оценки скорости скраба, сек. */
export const SCRUB_WINDOW = 0.15
/** Быстрый скраб: плейхед движется быстрее, чем на столько секунд таймлайна за секунду. */
export const FAST_SCRUB_SPEED = 3

/**
 * Скорость движения плейхеда при ручном скрабе. Пока она выше порога, превью показывает кадры
 * из атласа thumbs (seek `<video>` не успевает), после остановки — точный seek.
 */
export class ScrubTracker {
  private samples: { t: number; at: number }[] = []

  push(t: number, at: number): void {
    this.samples.push({ t, at })
    this.trim(at)
  }

  private trim(at: number): void {
    while (this.samples.length > 0 && at - this.samples[0]!.at > SCRUB_WINDOW) this.samples.shift()
  }

  /** Средняя скорость за окно, сек таймлайна / сек. */
  speed(at: number): number {
    this.trim(at)
    if (this.samples.length < 2) return 0
    let path = 0
    for (let i = 1; i < this.samples.length; i++)
      path += Math.abs(this.samples[i]!.t - this.samples[i - 1]!.t)
    return path / SCRUB_WINDOW
  }

  isFast(at: number): boolean {
    return this.speed(at) > FAST_SCRUB_SPEED
  }

  reset(): void {
    this.samples = []
  }
}
