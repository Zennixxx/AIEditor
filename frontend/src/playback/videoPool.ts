// Пул <video> на proxy.mp4: по элементу на активный клип видимых видеодорожек + предзагрузка клипов,
// которые начнутся в ближайшие 2 с. Во время воспроизведения позиция видео подтягивается к
// мастер-часам (drift.ts), на паузе — точный seek в кадр под плейхедом.
import { assetsApi } from '@/api/assets'
import { layerBlend, usableInterpolation } from '@/model/interpolation'
import type { Clip, Project } from '@/shared/types.gen'
import { canPlayNatively, correctDrift, onFrame } from './drift'
import { entrySource, upcomingVideoClips, videoLayersAt, type AssetLookup, type Layer } from './timing'
import { FRAME_EPS } from '@/shared/time'

export const PRELOAD_AHEAD = 2

interface Entry {
  el: HTMLVideoElement
  url: string
  clipId: string
}

export interface SyncOptions {
  playing: boolean
  /** Скорость транспорта (J/L), 1 — обычная. */
  transportRate: number
  /** На паузе: выполнять точный seek (false при быстром скрабе — показываются thumbs). */
  precise: boolean
  fps: number
  assets: AssetLookup
}

/** Есть ли proxy у ассета клипа (иначе показываем thumbs/картинку). */
export function proxyUrl(clip: Clip, assets: AssetLookup): string | null {
  const a = assets(clip.assetId)
  if (!a || a.kind !== 'video' || !a.derived.proxy) return null
  const interpolated = usableInterpolation(clip, assets)
  return assetsApi.fileUrl(interpolated?.derived.proxy ?? a.derived.proxy)
}

export function seekFps(clip: Clip, assets: AssetLookup, projectFps: number): number {
  const media = usableInterpolation(clip, assets)?.fps ?? assets(clip.assetId)?.fps ?? 0
  return Math.max(projectFps, media)
}

const NEXT = '#next'

export class VideoPool {
  private entries = new Map<string, Entry>()
  private listeners = new Set<() => void>()

  /** Подписка на появление новых кадров (loadeddata/seeked) — превью перерисовывается на паузе. */
  onFrame(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private emit = () => this.listeners.forEach((fn) => fn())

  element(clipId: string): HTMLVideoElement | null {
    return this.entries.get(clipId)?.el ?? null
  }

  partner(clipId: string): HTMLVideoElement | null {
    return this.entries.get(clipId + NEXT)?.el ?? null
  }

  /** Приводит пул в соответствие с моментом `t`; возвращает активные видеослои (верхний первым). */
  sync(project: Project, t: number, o: SyncOptions): Layer[] {
    const layers = videoLayersAt(project, t)
    const direction: 1 | -1 = o.transportRate < 0 ? -1 : 1
    const keep = new Set<string>()

    for (const layer of layers) {
      const url = proxyUrl(layer.clip, o.assets)
      if (!url) continue
      keep.add(layer.clip.id)
      const e = this.ensure(layer.clip.id, url)
      this.drive(e.el, layer, o)
      const blend = layerBlend(layer.clip, layer.src, layer.rate * o.transportRate, o.assets)
      if (blend) {
        keep.add(layer.clip.id + NEXT)
        const p = this.ensure(layer.clip.id + NEXT, url)
        if (!p.el.paused) p.el.pause()
        const target = clampToMedia(p.el, blend.next)
        if (!p.el.seeking && !onFrame(p.el.currentTime, target, blend.fps)) seek(p.el, target)
      }
    }

    // предзагрузка: следующий клип уже стоит на своём первом кадре
    const ahead = o.playing ? PRELOAD_AHEAD * Math.abs(o.transportRate) : PRELOAD_AHEAD
    for (const { clip } of upcomingVideoClips(project, t, ahead, direction)) {
      const url = proxyUrl(clip, o.assets)
      if (!url || keep.has(clip.id)) continue
      keep.add(clip.id)
      const fresh = !this.entries.has(clip.id)
      const e = this.ensure(clip.id, url)
      if (!e.el.paused) e.el.pause()
      const src = entrySource(clip, direction)
      if (fresh || (!e.el.seeking && !onFrame(e.el.currentTime, src, o.fps))) seek(e.el, src)
    }

    for (const [id, e] of this.entries) if (!keep.has(id)) this.release(id, e)
    return layers
  }

  private ensure(clipId: string, url: string): Entry {
    const existing = this.entries.get(clipId)
    if (existing && existing.url === url) return existing
    if (existing) this.release(clipId, existing)
    const el = document.createElement('video')
    el.muted = true // звук — через Web Audio (audioEngine)
    el.playsInline = true
    el.preload = 'auto'
    el.crossOrigin = 'anonymous'
    el.addEventListener('loadeddata', this.emit)
    el.addEventListener('seeked', this.emit)
    el.src = url
    const e = { el, url, clipId }
    this.entries.set(clipId, e)
    return e
  }

  private drive(el: HTMLVideoElement, layer: Layer, o: SyncOptions): void {
    const target = clampToMedia(el, layer.src)
    const rate = layer.rate * o.transportRate
    if (o.playing && canPlayNatively(rate)) {
      if (el.readyState < HTMLMediaElement.HAVE_METADATA) {
        el.currentTime = target
        return
      }
      const action = correctDrift(el.currentTime, target, rate, o.fps)
      if (action.kind === 'seek') {
        if (!el.seeking) seek(el, target + rate * 0.05) // небольшое упреждение на время seek
      }
      if (el.playbackRate !== action.rate) el.playbackRate = action.rate
      if (el.paused) void el.play().catch(() => undefined)
      return
    }
    // пауза, reverse или скорость вне диапазона браузера — видео стоит, кадр выставляется seek-ом
    if (!el.paused) el.pause()
    const needSeek = !onFrame(el.currentTime, target, seekFps(layer.clip, o.assets, o.fps))
    if (needSeek && !el.seeking && (o.playing || o.precise)) seek(el, target)
  }

  private release(clipId: string, e: Entry): void {
    e.el.pause()
    e.el.removeEventListener('loadeddata', this.emit)
    e.el.removeEventListener('seeked', this.emit)
    e.el.removeAttribute('src')
    e.el.load() // освобождает декодер
    this.entries.delete(clipId)
  }

  pauseAll(): void {
    for (const e of this.entries.values()) if (!e.el.paused) e.el.pause()
  }

  dispose(): void {
    for (const [id, e] of this.entries) this.release(id, e)
    this.listeners.clear()
  }
}

function clampToMedia(el: HTMLVideoElement, src: number): number {
  const d = el.duration
  const max = Number.isFinite(d) && d > 0 ? d - 0.001 : Infinity
  return Math.min(Math.max(src, 0), max)
}

function seek(el: HTMLVideoElement, t: number): void {
  el.currentTime = Math.max(0, t) + FRAME_EPS
}

/** Кадр видео готов к отрисовке и показывает `src` (на паузе) — иначе превью берёт кадр из thumbs. */
export function frameReady(el: HTMLVideoElement | null, src: number, fps: number, playing: boolean): boolean {
  if (!el || el.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return false
  if (playing) return true
  return !el.seeking && onFrame(el.currentTime, clampToMedia(el, src), fps)
}
