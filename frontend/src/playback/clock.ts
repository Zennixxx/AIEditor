// Мастер-часы воспроизведения. Источник времени — AudioContext.currentTime (по нему же планируется звук),
// пока контекст не запущен (нет жеста пользователя / нет Web Audio) — performance.now().
// Состояние — чистая структура: timeline time = anchorT + (now − anchorNow) · rate.

export interface ClockState {
  playing: boolean
  /** Скорость транспорта: 1 — обычная, 2/4/8 — перемотка L, отрицательная — J. */
  rate: number
  /** Timeline time в момент `anchorNow`. */
  anchorT: number
  /** Показание источника времени в момент якоря, сек. */
  anchorNow: number
}

export function stoppedClock(t = 0): ClockState {
  return { playing: false, rate: 1, anchorT: t, anchorNow: 0 }
}

export function clockTime(s: ClockState, now: number): number {
  return s.playing ? s.anchorT + (now - s.anchorNow) * s.rate : s.anchorT
}

export function clockPlay(s: ClockState, now: number, rate = s.rate): ClockState {
  return { playing: true, rate, anchorT: clockTime(s, now), anchorNow: now }
}

export function clockPause(s: ClockState, now: number): ClockState {
  return { ...s, playing: false, anchorT: clockTime(s, now), anchorNow: now }
}

export function clockSeek(s: ClockState, now: number, t: number): ClockState {
  return { ...s, anchorT: t, anchorNow: now }
}

/** Смена скорости без скачка позиции. */
export function clockSetRate(s: ClockState, now: number, rate: number): ClockState {
  return { ...s, rate, anchorT: clockTime(s, now), anchorNow: now }
}

/**
 * Перенос якоря на другой источник времени без скачка позиции
 * (AudioContext запустился посреди воспроизведения).
 */
export function clockRebase(s: ClockState, oldNow: number, newNow: number): ClockState {
  return { ...s, anchorT: clockTime(s, oldNow), anchorNow: newNow }
}

/** Следующая скорость шаттла J/L: повторное нажатие в ту же сторону удваивает (до ×8). */
export function shuttleRate(current: { playing: boolean; rate: number }, direction: 1 | -1): number {
  const MAX = 8
  if (current.playing && Math.sign(current.rate) === direction) {
    return direction * Math.min(MAX, Math.abs(current.rate) * 2)
  }
  return direction
}

export type TimeSourceKind = 'audio' | 'perf'

export interface TimeSample {
  /** AudioContext.currentTime, если контекст запущен, иначе null. */
  audio: number | null
  /** performance.now() в секундах. */
  perf: number
}

/** Часы с переключаемым источником: AudioContext, когда он `running`, иначе performance.now(). */
export class MasterClock {
  private state: ClockState = stoppedClock()
  private source: TimeSourceKind = 'perf'
  private last: { now: number; perf: number } | null = null

  constructor(private readonly read: () => TimeSample) {}

  private sample(): number {
    const s = this.read()
    const kind: TimeSourceKind = s.audio !== null ? 'audio' : 'perf'
    const now = s.audio ?? s.perf
    if (kind !== this.source) {
      // источник сменился: показание старого источника «сейчас» оцениваем по performance.now(),
      // и переносим якорь, чтобы позиция не прыгнула
      const oldNow = this.last ? this.last.now + (s.perf - this.last.perf) : now
      this.state = clockRebase(this.state, oldNow, now)
      this.source = kind
    }
    this.last = { now, perf: s.perf }
    return now
  }

  get sourceKind(): TimeSourceKind {
    this.sample()
    return this.source
  }

  get playing(): boolean {
    return this.state.playing
  }

  get rate(): number {
    return this.state.rate
  }

  /** Текущее показание источника (для планирования звука в том же времени). */
  now(): number {
    return this.sample()
  }

  time(): number {
    const now = this.sample() // sample() может перенести якорь — читаем state после него
    return clockTime(this.state, now)
  }

  play(rate: number): void {
    const now = this.sample()
    this.state = clockPlay(this.state, now, rate)
  }

  pause(): void {
    const now = this.sample()
    this.state = clockPause(this.state, now)
  }

  seek(t: number): void {
    const now = this.sample()
    this.state = clockSeek(this.state, now, t)
  }

  setRate(rate: number): void {
    const now = this.sample()
    this.state = clockSetRate(this.state, now, rate)
  }
}

export function performanceNow(): number {
  return performance.now() / 1000
}
