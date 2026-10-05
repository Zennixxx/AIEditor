// Кэш производных файлов ассетов для отрисовки: thumbs.json + JPG-атласы, waveform.json.
// Загрузка ленивая: геттер возвращает null и запускает загрузку; по готовности уведомляет подписчиков.
import { useSyncExternalStore } from 'react'
import { assetsApi } from '@/api/assets'
import type { Thumbs, Waveform } from '@/shared/types.gen'

type Entry<T> = { status: 'loading' } | { status: 'ready'; value: T } | { status: 'error' }

const thumbs = new Map<string, Entry<Thumbs>>()
const waveforms = new Map<string, Entry<Waveform>>()
const images = new Map<string, Entry<HTMLImageElement>>()
const listeners = new Set<() => void>()
let version = 0

function notify(): void {
  version++
  listeners.forEach((fn) => fn())
}

export function onMediaLoaded(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function load<T>(cache: Map<string, Entry<T>>, key: string, loader: () => Promise<T>): T | null {
  const e = cache.get(key)
  if (e) return e.status === 'ready' ? e.value : null
  cache.set(key, { status: 'loading' })
  loader().then(
    (value) => {
      cache.set(key, { status: 'ready', value })
      notify()
    },
    () => {
      cache.set(key, { status: 'error' })
      notify()
    },
  )
  return null
}

export function getThumbs(url: string | undefined): Thumbs | null {
  return url ? load(thumbs, url, () => assetsApi.thumbs(url)) : null
}

export function getWaveform(url: string | undefined): Waveform | null {
  return url ? load(waveforms, url, () => assetsApi.waveform(url)) : null
}

export function getImage(url: string): HTMLImageElement | null {
  return load(images, url, () => {
    return new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image()
      img.crossOrigin = 'anonymous'
      img.onload = () => resolve(img)
      img.onerror = () => reject(new Error(`image ${url}`))
      img.src = assetsApi.fileUrl(url)
    })
  })
}

/** Плитки на одном JPG-атласе. CONTRACT §3 не задаёт число строк; бэк делает атласы 10×10 (docs/BACKEND.md). */
export function tilesPerSprite(t: Thumbs): number {
  return t.columns * t.columns
}

export interface TileRef {
  sprite: string
  sx: number
  sy: number
  sw: number
  sh: number
}

/** Плитка атласа для source time `src`. */
export function thumbTile(t: Thumbs, src: number): TileRef | null {
  if (t.count <= 0) return null
  const index = Math.min(t.count - 1, Math.max(0, Math.floor(src / t.interval)))
  const per = tilesPerSprite(t)
  const sprite = t.sprites[Math.floor(index / per)]
  if (!sprite) return null
  const local = index % per
  return {
    sprite,
    sx: (local % t.columns) * t.tileWidth,
    sy: Math.floor(local / t.columns) * t.tileHeight,
    sw: t.tileWidth,
    sh: t.tileHeight,
  }
}

/** React-хук: перерисовать компонент, когда что-то догрузилось. */
export function useMediaVersion(): number {
  return useSyncExternalStore(onMediaLoaded, () => version)
}
