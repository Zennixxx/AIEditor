// Состояние интерфейса (не часть проекта, не попадает в историю): выделение, плейхед, зум, инструменты.
import { create } from 'zustand'
import type { ClipboardEntry } from '@/model/edit'

export type Tool = 'select' | 'blade'

export const MIN_PX_PER_SEC = 0.5
export const MAX_PX_PER_SEC = 2400

interface UiState {
  /** Выделенные элементы дорожек (клипы и эффекты fx-дорожек). */
  selection: string[]
  playhead: number
  /** Идёт воспроизведение — таймлайн автоскроллит за плейхедом. Управляется playback/player.ts. */
  playing: boolean
  /** Скорость транспорта: 1 — обычная, ±2/4/8 — шаттл J/L, отрицательная — назад. */
  playRate: number
  pxPerSec: number
  /** Время у левого края таймлайна, сек. */
  scrollX: number
  /** Вертикальный скролл дорожек, px. */
  scrollY: number
  /** Ширина области клипов, px (для зума/«вписать»). */
  viewWidth: number
  snapEnabled: boolean
  tool: Tool
  /** Solo аудиодорожек — состояние сессии, в проект не пишется. */
  solo: string[]
  clipboard: ClipboardEntry[]
  /** Ассет, который сейчас тащат из Media Bin (dataTransfer недоступен в dragover). */
  draggingAssetId: string | null

  select: (ids: string[]) => void
  setPlayhead: (t: number) => void
  setScroll: (x: number, y?: number) => void
  setViewWidth: (w: number) => void
  /** Зум с сохранением позиции времени `anchorTime` под экранной точкой `anchorX`. */
  zoomAt: (pxPerSec: number, anchorTime: number, anchorX: number) => void
  setSnap: (on: boolean) => void
  setTool: (tool: Tool) => void
  toggleSolo: (trackId: string) => void
  setClipboard: (entries: ClipboardEntry[]) => void
  setDraggingAsset: (id: string | null) => void
}

export function clampZoom(pxPerSec: number): number {
  return Math.min(MAX_PX_PER_SEC, Math.max(MIN_PX_PER_SEC, pxPerSec))
}

export const useUi = create<UiState>()((set, get) => ({
  selection: [],
  playhead: 0,
  playing: false,
  playRate: 1,
  pxPerSec: 40,
  scrollX: 0,
  scrollY: 0,
  viewWidth: 800,
  snapEnabled: true,
  tool: 'select',
  solo: [],
  clipboard: [],
  draggingAssetId: null,

  select: (ids) => set({ selection: [...new Set(ids)] }),
  setPlayhead: (t) => set({ playhead: Math.max(0, t) }),
  setScroll: (x, y) =>
    set({ scrollX: Math.max(0, x), ...(y !== undefined ? { scrollY: Math.max(0, y) } : {}) }),
  setViewWidth: (w) => set({ viewWidth: Math.max(1, w) }),
  zoomAt: (pxPerSec, anchorTime, anchorX) => {
    const z = clampZoom(pxPerSec)
    set({ pxPerSec: z, scrollX: Math.max(0, anchorTime - anchorX / z) })
  },
  setSnap: (on) => set({ snapEnabled: on }),
  setTool: (tool) => set({ tool }),
  toggleSolo: (trackId) => {
    const solo = get().solo
    set({ solo: solo.includes(trackId) ? solo.filter((id) => id !== trackId) : [...solo, trackId] })
  },
  setClipboard: (clipboard) => set({ clipboard }),
  setDraggingAsset: (draggingAssetId) => set({ draggingAssetId }),
}))
