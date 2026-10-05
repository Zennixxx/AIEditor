// Транспорт: связывает мастер-часы, звук (audioEngine), видео (videoPool) и store/ui.
// Во время воспроизведения rAF-цикл двигает ui.playhead; ручное изменение плейхеда (скраб, клик
// по линейке) во время воспроизведения — seek.
import { snapToFrame } from '@/shared/time'
import type { Asset, Project } from '@/shared/types.gen'
import { useAssets } from '@/store/assets'
import { useProject } from '@/store/project'
import { useUi } from '@/store/ui'
import { AudioEngine, SCHEDULE_AHEAD } from './audioEngine'
import { MasterClock, performanceNow, shuttleRate } from './clock'
import { ScrubTracker } from './drift'
import type { AssetLookup } from './timing'
import { VideoPool } from './videoPool'

/** Как часто (в секундах таймлайна при rate 1) перепланировать звук. */
const AUDIO_TICK = SCHEDULE_AHEAD / 4

const raf: (cb: () => void) => number =
  typeof requestAnimationFrame === 'function'
    ? (cb) => requestAnimationFrame(cb)
    : (cb) => setTimeout(cb, 16) as unknown as number
const cancelRaf: (id: number) => void =
  typeof cancelAnimationFrame === 'function' ? (id) => cancelAnimationFrame(id) : (id) => clearTimeout(id)

export function assetLookup(project: Pick<Project, 'assets'>): AssetLookup {
  const lib = useAssets.getState().assets
  return (id: string): Asset | undefined => lib[id] ?? project.assets.find((a) => a.id === id)
}

export class Player {
  readonly audio = new AudioEngine()
  readonly video = new VideoPool()
  readonly scrub = new ScrubTracker()
  private readonly clock = new MasterClock(() => ({
    audio: this.audio.runningTime(),
    perf: performanceNow(),
  }))
  private frame = 0
  private lastAudioTick = -Infinity
  /** Плейхед, выставленный самим плеером (чтобы отличить его от ручного скраба). */
  private ownPlayhead: number | null = null
  private unsubs: (() => void)[] = []
  private settleTimer: ReturnType<typeof setTimeout> | null = null
  private frameListeners = new Set<() => void>()

  /** Подписка на сторы; возвращает функцию остановки. */
  start(): () => void {
    this.unsubs.push(
      useUi.subscribe((s, prev) => {
        if (s.playhead !== prev.playhead && s.playhead !== this.ownPlayhead) this.onExternalSeek(s.playhead)
        if (s.solo !== prev.solo && s.playing) this.restartAudio()
      }),
      useProject.subscribe((s, prev) => {
        if (s.project === prev.project) return
        this.audio.preload(s.project, assetLookup(s.project))
        if (useUi.getState().playing) this.restartAudio()
        else this.syncVideo(true)
        this.requestFrame()
      }),
      useAssets.subscribe((s, prev) => {
        if (s.assets === prev.assets) return
        const p = useProject.getState().project
        this.audio.preload(p, assetLookup(p))
        if (!useUi.getState().playing) this.syncVideo(true)
        this.requestFrame()
      }),
      this.audio.onBufferLoaded(() => {
        if (useUi.getState().playing) this.audioTick(true)
      }),
      this.video.onFrame(() => this.requestFrame()),
    )
    const p = useProject.getState().project
    this.audio.preload(p, assetLookup(p))
    this.syncVideo(true)
    return () => this.stop()
  }

  stop(): void {
    this.pause()
    this.unsubs.forEach((u) => u())
    this.unsubs = []
    if (this.settleTimer) clearTimeout(this.settleTimer)
    this.video.dispose()
    this.audio.dispose()
  }

  /** Превью подписывается, чтобы перерисоваться (новый кадр видео, догрузка, смена режима скраба). */
  onFrame(fn: () => void): () => void {
    this.frameListeners.add(fn)
    return () => this.frameListeners.delete(fn)
  }

  private requestFrame(): void {
    this.frameListeners.forEach((fn) => fn())
  }

  get playing(): boolean {
    return useUi.getState().playing
  }

  // --- команды транспорта ---

  toggle(): void {
    if (this.playing) this.pause()
    else this.play(1)
  }

  play(rate = 1): void {
    const ui = useUi.getState()
    const duration = useProject.getState().project.duration
    let t = ui.playhead
    // с конца — заново с начала (и наоборот для обратного хода)
    if (rate > 0 && t >= duration - 1e-6) t = 0
    if (rate < 0 && t <= 1e-6) t = duration
    void this.audio.resume().then(() => {
      // контекст запустился — часы переходят на его время без скачка, звук планируется заново
      if (this.playing) this.restartAudio()
    })
    this.clock.seek(t)
    this.clock.play(rate)
    this.setPlayhead(t)
    useUi.setState({ playing: true, playRate: rate })
    this.restartAudio()
    if (!this.frame) this.frame = raf(this.loop)
  }

  pause(): void {
    if (this.frame) cancelRaf(this.frame)
    this.frame = 0
    const was = this.playing
    if (was) {
      this.clock.pause()
      const t = this.clampTime(this.clock.time())
      useUi.setState({ playing: false, playRate: 1 })
      this.setPlayhead(snapToFrame(t, useProject.getState().project.fps))
    }
    this.audio.stopAll()
    this.video.pauseAll()
    this.syncVideo(true)
    this.requestFrame()
  }

  /** J (−1) / L (+1): запуск в эту сторону, повторное нажатие — ×2. */
  shuttle(direction: 1 | -1): void {
    const ui = useUi.getState()
    const rate = shuttleRate({ playing: ui.playing, rate: ui.playRate }, direction)
    if (ui.playing) {
      this.clock.setRate(rate)
      useUi.setState({ playRate: rate })
      this.restartAudio()
    } else {
      this.play(rate)
    }
  }

  /** Шаг на `frames` кадров (←/→): останавливает воспроизведение. */
  step(frames: number): void {
    if (this.playing) this.pause()
    const { fps } = useProject.getState().project
    const t = snapToFrame(useUi.getState().playhead, fps) + frames / fps
    useUi.getState().setPlayhead(this.clampTime(snapToFrame(t, fps)))
  }

  seek(t: number): void {
    useUi.getState().setPlayhead(this.clampTime(t))
  }

  home(): void {
    this.seek(0)
  }

  end(): void {
    this.seek(useProject.getState().project.duration)
  }

  // --- внутреннее ---

  private clampTime(t: number): number {
    return Math.min(Math.max(t, 0), useProject.getState().project.duration)
  }

  private setPlayhead(t: number): void {
    this.ownPlayhead = Math.max(0, t)
    useUi.getState().setPlayhead(t)
  }

  private onExternalSeek(t: number): void {
    this.ownPlayhead = null
    if (this.playing) {
      this.clock.seek(t)
      this.restartAudio()
      return
    }
    // пауза: скраб — быстрый показ из thumbs, после остановки — точный seek
    const now = performanceNow()
    this.scrub.push(t, now)
    this.syncVideo(!this.scrub.isFast(now))
    if (this.settleTimer) clearTimeout(this.settleTimer)
    this.settleTimer = setTimeout(() => {
      this.settleTimer = null
      if (!this.playing) this.syncVideo(true)
      this.requestFrame()
    }, 160)
    this.requestFrame()
  }

  /** Режим кадра на паузе: true — точный seek выполнен/выполняется, false — быстрый скраб (thumbs). */
  scrubbingFast(): boolean {
    return !this.playing && this.scrub.isFast(performanceNow())
  }

  private syncVideo(precise: boolean): void {
    const ui = useUi.getState()
    const project = useProject.getState().project
    this.video.sync(project, ui.playhead, {
      playing: ui.playing,
      transportRate: ui.playRate,
      precise,
      fps: project.fps,
      assets: assetLookup(project),
    })
  }

  private restartAudio(): void {
    this.audio.stopAll()
    this.audioTick(true)
  }

  private audioTick(force: boolean): void {
    const ui = useUi.getState()
    const t = this.clock.time()
    if (!force && Math.abs(t - this.lastAudioTick) < AUDIO_TICK) return
    this.lastAudioTick = t
    const project = useProject.getState().project
    this.audio.tick({
      project,
      t,
      now: this.clock.now(),
      rate: ui.playRate,
      solo: ui.solo,
      assets: assetLookup(project),
    })
  }

  private loop = (): void => {
    this.frame = 0
    if (!this.playing) return
    const project = useProject.getState().project
    const rate = useUi.getState().playRate
    const t = this.clock.time()
    if ((rate > 0 && t >= project.duration) || (rate < 0 && t <= 0)) {
      this.clock.seek(rate > 0 ? project.duration : 0)
      this.pause()
      return
    }
    this.setPlayhead(t)
    this.syncVideo(true)
    this.audioTick(false)
    this.requestFrame()
    this.frame = raf(this.loop)
  }
}

/** Единственный плеер приложения. */
export const player = new Player()
