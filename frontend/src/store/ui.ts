// Состояние интерфейса (не часть проекта, не попадает в историю): выделение, плейхед, зум, инструменты.
import { create } from 'zustand'
import type { KeyRef } from '@/model/clipKeys'
import type { ClipboardEntry } from '@/model/edit'
import { LANE_PROPS, type LaneProp } from '@/model/keyframes'
import { DEFAULT_VISIBILITY, type MarkerVisibility } from '@/model/markers'

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
  /** Выделенные маркеры (клипов и проекта) — отдельно от выделения элементов дорожек. */
  markerSelection: string[]
  /** Фильтр видимости маркеров: порог силы и виды. Скрытые не участвуют в привязке и макро-ops. */
  markerVisibility: MarkerVisibility
  /** Маркер, у которого инспектор должен сфокусировать поле label (двойной клик). */
  focusMarkerId: string | null
  /** Ассет, который сейчас тащат из Media Bin (dataTransfer недоступен в dragover). */
  draggingAssetId: string | null
  /** Открыт диалог «Нарезать по маркерам». */
  cutDialogOpen: boolean
  /** Открыт диалог «Эффект по маркерам» с предвыбранным эффектом. */
  fxDialog: { effect: string } | null
  /** Эффект, который сейчас тащат из библиотеки эффектов. */
  draggingEffect: string | null
  /** Пресет-комбо, который сейчас тащат из библиотеки. */
  draggingPreset: string | null
  /** Эффект клипа, раскрытый в инспекторе. */
  inspectedEffectId: string | null
  /** Показанные дорожки свойств под видеодорожками (P/S/R/T), в порядке LANE_PROPS. */
  propLanes: LaneProp[]
  /** Выделенные ключевые кадры на дорожках свойств. */
  keySelection: KeyRef[]

  select: (ids: string[]) => void
  selectMarkers: (ids: string[]) => void
  setMarkerVisibility: (patch: Partial<MarkerVisibility>) => void
  focusMarker: (id: string | null) => void
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
  setCutDialogOpen: (open: boolean) => void
  openFxDialog: (effect: string | null) => void
  setDraggingEffect: (effect: string | null) => void
  setDraggingPreset: (presetId: string | null) => void
  inspectEffect: (id: string | null) => void
  toggleLane: (lane: LaneProp) => void
  setLanes: (lanes: readonly LaneProp[]) => void
  selectKeys: (refs: KeyRef[]) => void
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
  markerSelection: [],
  markerVisibility: DEFAULT_VISIBILITY,
  focusMarkerId: null,
  draggingAssetId: null,
  cutDialogOpen: false,
  fxDialog: null,
  draggingEffect: null,
  draggingPreset: null,
  inspectedEffectId: null,
  propLanes: [],
  keySelection: [],

  select: (ids) => set({ selection: [...new Set(ids)] }),
  selectMarkers: (ids) => set({ markerSelection: [...new Set(ids)] }),
  setMarkerVisibility: (patch) => set((s) => ({ markerVisibility: { ...s.markerVisibility, ...patch } })),
  focusMarker: (focusMarkerId) => set({ focusMarkerId }),
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
  setCutDialogOpen: (cutDialogOpen) => set({ cutDialogOpen }),
  openFxDialog: (effect) => set({ fxDialog: effect === null ? null : { effect } }),
  setDraggingEffect: (draggingEffect) => set({ draggingEffect }),
  setDraggingPreset: (draggingPreset) => set({ draggingPreset }),
  inspectEffect: (inspectedEffectId) => set({ inspectedEffectId }),
  toggleLane: (lane) => {
    const on = get().propLanes.includes(lane)
    get().setLanes(on ? get().propLanes.filter((l) => l !== lane) : [...get().propLanes, lane])
  },
  setLanes: (lanes) => set({ propLanes: LANE_PROPS.filter((l) => lanes.includes(l)) }),
  selectKeys: (keySelection) => set({ keySelection }),
}))
