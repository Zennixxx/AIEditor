// Инструменты взаимодействия с таймлайном: скраб, выделение (клик/рамка), перемещение, трим, лезвие,
// drop ассета из Media Bin, зум/скролл. Состояние жестов — здесь; проект меняется только через dispatch.
import { addTransitions, dropEffect, dropPreset } from '@/app/actions'
import { planAssetDrop, planMove, planTrim, pickTrackForAsset, type ItemMove } from '@/model/edit'
import type { EffectDropTarget } from '@/model/effects'
import { planShiftKeys, sameKey, shiftedRefs, type KeyRef } from '@/model/clipKeys'
import { isClip } from '@/model/lookup'
import {
  isMarkerVisible,
  markerOrigins,
  planMoveMarkers,
  timelineMarkers,
  type MarkerOrigin,
  type TimelineMarker,
} from '@/model/markers'
import { timelineSections, type TimelineSection } from '@/model/sections'
import { isTransition, nearestCut, planTransitions } from '@/model/transitions'
import { presetSpan } from '@/model/presets'
import { findPreset } from '@/store/presets'
import { OpsError } from '@/model/ops/errors'
import { assetClipDuration } from '@/model/project'
import { getEffectDef } from '@/shared/effects-registry'
import { collectSnapTargets, snapPoint, snapSpan, snapThreshold, type SnapTarget } from '@/model/snapping'
import { snapToFrame } from '@/shared/time'
import type { Project, Track, TrackItem } from '@/shared/types.gen'
import { displayedProject, useAi } from '@/store/ai'
import { useAssets } from '@/store/assets'
import { autoAnalyzeClips } from '@/store/analysis'
import { useProject } from '@/store/project'
import { useUi } from '@/store/ui'
import {
  hitTest,
  itemsInRect,
  layoutTracks,
  maxScrollY,
  RULER_H,
  rowAtY,
  rowScreenTop,
  xToTime,
  type TrackRow,
  type View,
} from './geometry'
import { hitKey, layoutKeys, type KeyView } from './keyLayout'
import { hitMarker, layoutMarkers, markersInRect, type MarkerView } from './markerLayout'
import { emptyOverlay, SPEED_STRIP_H, type Overlay } from './render'

export interface PointerInfo {
  x: number
  y: number
  button: number
  shift: boolean
  ctrl: boolean
  alt: boolean
}

interface MoveItem {
  id: string
  item: TrackItem
  start: number
  rowIndex: number
  fromKind: Track['kind']
}

type Gesture =
  | { kind: 'scrub' }
  | {
      kind: 'move'
      downX: number
      downY: number
      started: boolean
      primary: MoveItem
      items: MoveItem[]
      targets: SnapTarget[]
      moves: ItemMove[] | null
      /** Клик по уже выделенному без движения → выделить только его. */
      collapseTo: string | null
    }
  | {
      kind: 'trim'
      itemId: string
      edge: 'start' | 'end'
      downX: number
      origin: number
      targets: SnapTarget[]
      key: string
    }
  | { kind: 'box'; x0: number; y0: number; base: string[] }
  | { kind: 'markerBox'; x0: number; y0: number; base: string[] }
  | {
      kind: 'marker'
      downX: number
      started: boolean
      primaryId: string
      /** Позиция главного маркера на таймлайне в начале жеста. */
      primaryT0: number
      origins: MarkerOrigin[]
      targets: SnapTarget[]
      lastDelta: number
      key: string
      /** Клик по уже выделенному маркеру без движения: выделить только его. */
      collapseTo: string | null
    }
  | {
      kind: 'keys'
      downX: number
      started: boolean
      /** Проект в начале жеста: ops считаются от него с полной дельтой. */
      base: Project
      refs: KeyRef[]
      /** Timeline time главного ключа в начале жеста. */
      primaryT0: number
      targets: SnapTarget[]
      lastDelta: number
      key: string
      collapseTo: KeyRef | null
    }

const DRAG_THRESHOLD_PX = 3
/** Переход «прилипает» к стыку не дальше этого расстояния от курсора, px. */
const TRANSITION_SNAP_PX = 150
let gestureSeq = 0

export interface ControllerHost {
  size: () => { width: number; height: number }
  redraw: () => void
  setCursor: (cursor: string) => void
}

export class TimelineController {
  overlay: Overlay = emptyOverlay()
  private gesture: Gesture | null = null
  private rowsCache: { project: Project; lanes: readonly unknown[]; rows: TrackRow[] } | null = null
  private keyCache: { key: readonly unknown[]; value: KeyView[] } | null = null
  private dropTargets: SnapTarget[] | null = null
  private markerCache: { key: readonly unknown[]; value: MarkerView[] } | null = null
  private timelineMarkerCache: { key: readonly unknown[]; value: TimelineMarker[] } | null = null
  private sectionCache: { project: Project; value: TimelineSection[] } | null = null

  constructor(private readonly host: ControllerHost) {}

  view(): View {
    const { pxPerSec, scrollX, scrollY } = useUi.getState()
    const { width, height } = this.host.size()
    return { pxPerSec, scrollX, scrollY, width, height }
  }

  rows(): TrackRow[] {
    const project = displayedProject()
    const lanes = useUi.getState().propLanes
    if (this.rowsCache?.project !== project || this.rowsCache.lanes !== lanes)
      this.rowsCache = { project, lanes, rows: layoutTracks(project, lanes) }
    return this.rowsCache.rows
  }

  /** Ключевые кадры на дорожках свойств в экранных координатах (кэш по раскладке, виду и выделению). */
  keys(): KeyView[] {
    const rows = this.rows()
    if (!rows.some((r) => r.lanes.length > 0)) return []
    const v = this.view()
    const sel = useUi.getState().keySelection
    const key = [rows, v.pxPerSec, v.scrollX, v.scrollY, v.width, v.height, sel]
    const c = this.keyCache
    if (c && c.key.every((k, i) => k === key[i])) return c.value
    const value = layoutKeys(rows, v, sel)
    this.keyCache = { key, value }
    return value
  }

  private snapOpts(shift: boolean) {
    const ui = useUi.getState()
    return {
      enabled: ui.snapEnabled && !shift,
      threshold: snapThreshold(ui.pxPerSec),
      fps: useProject.getState().project.fps,
    }
  }

  private targets(exclude: Iterable<string>, excludeMarkers?: ReadonlySet<string>): SnapTarget[] {
    const vis = useUi.getState().markerVisibility
    return collectSnapTargets(useProject.getState().project, {
      playhead: useUi.getState().playhead,
      exclude: new Set(exclude),
      // скрытые фильтром маркеры не участвуют в привязке
      markerVisible: (m) => isMarkerVisible(m, vis),
      ...(excludeMarkers ? { excludeMarkers } : {}),
    })
  }

  /** Маркеры в экранных координатах (кэш по проекту, виду, фильтру и выделению). */
  markers(): MarkerView[] {
    const { markerVisibility, markerSelection } = useUi.getState()
    const v = this.view()
    const project = displayedProject()
    const key = [
      project,
      v.pxPerSec,
      v.scrollX,
      v.scrollY,
      v.width,
      v.height,
      markerVisibility,
      markerSelection,
    ]
    const c = this.markerCache
    if (c && c.key.every((k, i) => k === key[i])) return c.value
    const value = this.markersFor(v)
    this.markerCache = { key, value }
    return value
  }

  /** Маркеры в timeline time после фильтра видимости (кэш по проекту и фильтру — не зависит от скролла). */
  private timelineMarkers(): TimelineMarker[] {
    const project = displayedProject()
    const vis = useUi.getState().markerVisibility
    const c = this.timelineMarkerCache
    if (c && c.key[0] === project && c.key[1] === vis) return c.value
    const value = timelineMarkers(project, vis)
    this.timelineMarkerCache = { key: [project, vis], value }
    return value
  }

  /** Маркеры для произвольного вида (слой дорожек шире экрана), без кэша. */
  markersFor(v: View): MarkerView[] {
    const { markerVisibility, markerSelection } = useUi.getState()
    return layoutMarkers(
      displayedProject(),
      this.rows(),
      v,
      markerVisibility,
      new Set(markerSelection),
      this.timelineMarkers(),
    )
  }

  /** Ключевые кадры для произвольного вида, без кэша. */
  keysFor(v: View): KeyView[] {
    const rows = this.rows()
    if (!rows.some((r) => r.lanes.length > 0)) return []
    return layoutKeys(rows, v, useUi.getState().keySelection)
  }

  /** Секции композиции и музыки в timeline time (кэш по проекту). */
  sections(): TimelineSection[] {
    const project = displayedProject()
    if (this.sectionCache?.project !== project)
      this.sectionCache = { project, value: timelineSections(project) }
    return this.sectionCache.value
  }

  // --- указатель ---

  pointerDown(p: PointerInfo): boolean {
    if (p.button !== 0) return false
    // предпросмотр ИИ: таймлайн показывает результат ops, правка заблокирована — только скраб по линейке
    if (useAi.getState().preview && p.y >= RULER_H) return false
    const v = this.view()
    const rows = this.rows()
    const hit = hitTest(rows, v, p.x, p.y)
    const ui = useUi.getState()
    const fps = useProject.getState().project.fps

    // ключевые кадры на дорожках свойств
    const key = hitKey(this.keys(), p.x, p.y)
    if (key) return this.pointerDownKey(key, p)
    if (!p.ctrl && !p.shift && ui.keySelection.length > 0) ui.selectKeys([])

    // маркеры - над всем остальным (в том числе над линейкой)
    const marker = hitMarker(this.markers(), p.x, p.y)
    if (marker) return this.pointerDownMarker(marker, p)
    if (!p.ctrl && !p.shift && !p.alt && ui.markerSelection.length > 0) ui.selectMarkers([])
    if (p.alt) {
      // Alt + рамка: выделение маркеров
      this.gesture = {
        kind: 'markerBox',
        x0: p.x,
        y0: p.y,
        base: p.ctrl || p.shift ? ui.markerSelection : [],
      }
      return true
    }

    if (hit.area === 'ruler') {
      this.gesture = { kind: 'scrub' }
      ui.setPlayhead(snapToFrame(hit.t, fps))
      return true
    }

    if (hit.area === 'item' && !hit.row.track.locked) {
      if (ui.tool === 'blade') {
        if (isClip(hit.item)) {
          const at = snapPoint(hit.t, this.targets([hit.item.id]), this.snapOpts(p.shift)).value
          useProject.getState().dispatch([{ op: 'splitClip', clipId: hit.item.id, at }], { label: 'Лезвие' })
        }
        return true
      }
      const id = hit.item.id
      if (hit.zone !== 'body') {
        if (!ui.selection.includes(id)) ui.select([id])
        this.gesture = {
          kind: 'trim',
          itemId: id,
          edge: hit.zone,
          downX: p.x,
          origin: hit.zone === 'start' ? hit.item.start : hit.item.start + hit.item.duration,
          targets: this.targets([id]),
          key: `trim:${id}:${++gestureSeq}`,
        }
        return true
      }
      let selection = ui.selection
      let collapseTo: string | null = null
      if (p.ctrl || p.shift) {
        selection = selection.includes(id) ? selection.filter((s) => s !== id) : [...selection, id]
        ui.select(selection)
        if (!selection.includes(id)) return true
      } else if (!selection.includes(id)) {
        selection = [id]
        ui.select(selection)
      } else {
        collapseTo = id
      }
      const items = this.collectMoveItems(rows, selection)
      const primary = items.find((i) => i.id === id)
      if (!primary) return true
      this.gesture = {
        kind: 'move',
        downX: p.x,
        downY: p.y,
        started: false,
        primary,
        items,
        targets: this.targets(items.map((i) => i.id)),
        moves: null,
        collapseTo,
      }
      return true
    }

    if (hit.area === 'track' || hit.area === 'lane' || hit.area === 'empty' || hit.area === 'item') {
      const base = p.ctrl || p.shift ? ui.selection : []
      if (!p.ctrl && !p.shift) ui.select([])
      this.gesture = { kind: 'box', x0: p.x, y0: p.y, base }
      return true
    }
    return false
  }

  private pointerDownMarker(m: MarkerView, p: PointerInfo): boolean {
    const ui = useUi.getState()
    let selection = ui.markerSelection
    let collapseTo: string | null = null
    if (p.ctrl || p.shift) {
      selection = selection.includes(m.id) ? selection.filter((s) => s !== m.id) : [...selection, m.id]
      ui.selectMarkers(selection)
      if (!selection.includes(m.id)) return true
    } else if (!selection.includes(m.id)) {
      selection = [m.id]
      ui.selectMarkers(selection)
    } else {
      collapseTo = m.id
    }
    const project = useProject.getState().project
    const origins = markerOrigins(project, selection)
    const primary = origins.find((o) => o.id === m.id)
    if (!primary) return true
    this.gesture = {
      kind: 'marker',
      downX: p.x,
      started: false,
      primaryId: m.id,
      primaryT0: primary.t,
      origins,
      targets: this.targets([], new Set(origins.map((o) => o.id))),
      lastDelta: 0,
      key: `marker:${m.id}:${++gestureSeq}`,
      collapseTo,
    }
    return true
  }

  private pointerDownKey(k: KeyView, p: PointerInfo): boolean {
    const ui = useUi.getState()
    let selection = ui.keySelection
    let collapseTo: KeyRef | null = null
    const has = selection.some((s) => sameKey(s, k.ref))
    if (p.ctrl || p.shift) {
      selection = has ? selection.filter((s) => !sameKey(s, k.ref)) : [...selection, k.ref]
      ui.selectKeys(selection)
      if (has) return true
    } else if (!has) {
      selection = [k.ref]
      ui.selectKeys(selection)
    } else {
      collapseTo = k.ref
    }
    // клип ключа становится выделенным (инспектор показывает его свойства)
    if (!ui.selection.includes(k.ref.clipId)) ui.select([k.ref.clipId])
    this.gesture = {
      kind: 'keys',
      downX: p.x,
      started: false,
      base: useProject.getState().project,
      refs: selection,
      primaryT0: k.clip.start + k.ref.t,
      targets: this.targets([]),
      lastDelta: 0,
      key: `keys:${++gestureSeq}`,
      collapseTo,
    }
    return true
  }

  private dragKeys(g: Extract<Gesture, { kind: 'keys' }>, p: PointerInfo, v: View): void {
    if (!g.started) {
      if (Math.abs(p.x - g.downX) < DRAG_THRESHOLD_PX) return
      g.started = true
    }
    const raw = g.primaryT0 + (p.x - g.downX) / v.pxPerSec
    const snapped = snapPoint(raw, g.targets, this.snapOpts(p.shift))
    this.overlay.snapAt = snapped.snappedAt
    const delta = snapped.value - g.primaryT0
    if (Math.abs(delta - g.lastDelta) > 1e-9) {
      g.lastDelta = delta
      const ops = planShiftKeys(g.base, g.refs, delta)
      useProject.getState().dispatch(ops, { label: 'Переместить ключи', mergeKey: g.key })
      useUi.getState().selectKeys(shiftedRefs(g.base, g.refs, delta))
    }
    this.host.redraw()
  }

  /** Двойной клик по маркеру: редактирование label/цвета в инспекторе; по ключу — плейхед на ключ. */
  doubleClick(p: PointerInfo): boolean {
    if (useAi.getState().preview) return false
    const key = hitKey(this.keys(), p.x, p.y)
    if (key) {
      useUi.getState().setPlayhead(key.clip.start + key.ref.t)
      return true
    }
    const m = hitMarker(this.markers(), p.x, p.y)
    if (m) {
      useUi.getState().selectMarkers([m.id])
      useUi.getState().focusMarker(m.id)
      return true
    }
    const hit = hitTest(this.rows(), this.view(), p.x, p.y)
    if (hit.area !== 'item' || hit.row.track.kind !== 'video' || !isClip(hit.item)) return false
    const bottom = rowScreenTop(hit.row, this.view()) + hit.row.itemHeight - 2
    if (p.y < bottom - SPEED_STRIP_H - 6) return false
    useUi.getState().select([hit.item.id])
    useUi.getState().openCurveEditor(hit.item.id)
    return true
  }

  private collectMoveItems(rows: readonly TrackRow[], ids: readonly string[]): MoveItem[] {
    const want = new Set(ids)
    const res: MoveItem[] = []
    for (const row of rows) {
      if (row.track.locked) continue
      for (const item of row.track.items) {
        if (want.has(item.id))
          res.push({ id: item.id, item, start: item.start, rowIndex: row.index, fromKind: row.track.kind })
      }
    }
    return res
  }

  pointerMove(p: PointerInfo): void {
    const g = this.gesture
    if (!g) return this.hover(p)
    const v = this.view()
    const fps = useProject.getState().project.fps
    switch (g.kind) {
      case 'scrub':
        useUi.getState().setPlayhead(snapToFrame(Math.max(0, xToTime(p.x, v)), fps))
        return
      case 'trim': {
        const raw = g.origin + (p.x - g.downX) / v.pxPerSec
        const snapped = snapPoint(raw, g.targets, this.snapOpts(p.shift))
        this.overlay.snapAt = snapped.snappedAt
        const op = planTrim(useProject.getState().project, g.itemId, g.edge, snapped.value)
        if (op) useProject.getState().dispatch([op], { label: 'Трим', mergeKey: g.key })
        this.host.redraw()
        return
      }
      case 'box': {
        this.overlay.box = { x0: g.x0, y0: g.y0, x1: p.x, y1: p.y }
        const inside = itemsInRect(this.rows(), v, this.overlay.box)
        useUi.getState().select([...g.base, ...inside])
        this.host.redraw()
        return
      }
      case 'move':
        return this.dragMove(g, p, v)
      case 'markerBox': {
        this.overlay.box = { x0: g.x0, y0: g.y0, x1: p.x, y1: p.y }
        const inside = markersInRect(this.markers(), this.rows(), v, this.overlay.box)
        useUi.getState().selectMarkers([...g.base, ...inside])
        this.host.redraw()
        return
      }
      case 'marker':
        return this.dragMarker(g, p, v)
      case 'keys':
        return this.dragKeys(g, p, v)
    }
  }

  private dragMarker(g: Extract<Gesture, { kind: 'marker' }>, p: PointerInfo, v: View): void {
    if (!g.started) {
      if (Math.abs(p.x - g.downX) < DRAG_THRESHOLD_PX) return
      g.started = true
    }
    // привязка и квантование к кадру - по главному маркеру; остальные едут на ту же дельту
    const raw = g.primaryT0 + (p.x - g.downX) / v.pxPerSec
    const snapped = snapPoint(raw, g.targets, this.snapOpts(p.shift))
    this.overlay.snapAt = snapped.snappedAt
    const delta = snapped.value - g.primaryT0
    if (Math.abs(delta - g.lastDelta) > 1e-9) {
      g.lastDelta = delta
      const project = useProject.getState().project
      const ops = planMoveMarkers(project, g.origins, delta)
      useProject.getState().dispatch(ops, { label: 'Переместить маркер', mergeKey: g.key })
    }
    this.host.redraw()
  }

  private dragMove(g: Extract<Gesture, { kind: 'move' }>, p: PointerInfo, v: View): void {
    if (!g.started) {
      if (Math.abs(p.x - g.downX) < DRAG_THRESHOLD_PX && Math.abs(p.y - g.downY) < DRAG_THRESHOLD_PX) return
      g.started = true
    }
    const project = useProject.getState().project
    const rows = this.rows()
    const raw = g.primary.start + (p.x - g.downX) / v.pxPerSec
    const snapped = snapSpan(raw, g.primary.item.duration, g.targets, this.snapOpts(p.shift))
    let delta = snapped.value - g.primary.start
    const minStart = Math.min(...g.items.map((i) => i.start))
    let snapAt = snapped.snappedAt
    if (minStart + delta < 0) {
      delta = -minStart
      snapAt = null
    }
    // смена дорожки: по строке под курсором, только на дорожки того же типа
    const accepts = (it: MoveItem, t: Track | undefined) =>
      !!t && !t.locked && (isClip(it.item) ? t.kind === it.fromKind : t.kind === 'fx')
    const under = rowAtY(rows, p.y, v)
    let dr = under && accepts(g.primary, under.track) ? under.index - g.primary.rowIndex : 0
    if (dr !== 0 && !g.items.every((it) => accepts(it, rows[it.rowIndex + dr]?.track))) dr = 0

    g.moves = g.items.map((it) => ({
      id: it.id,
      start: snapToFrame(it.start + delta, project.fps),
      trackId: rows[it.rowIndex + dr]!.track.id,
    }))
    const valid = planMove(project, g.moves, { rippleInsert: p.alt }) !== null
    this.overlay.ghosts = g.items.map((it, i) => ({
      item: it.item,
      start: g.moves![i]!.start,
      trackId: g.moves![i]!.trackId,
      valid,
    }))
    this.overlay.snapAt = snapAt
    this.host.redraw()
  }

  pointerUp(p: PointerInfo): void {
    const g = this.gesture
    this.gesture = null
    if (!g) return
    if (g.kind === 'trim') useProject.getState().sealHistory()
    if (g.kind === 'marker') {
      if (g.started) useProject.getState().sealHistory()
      else if (g.collapseTo) useUi.getState().selectMarkers([g.collapseTo])
    }
    if (g.kind === 'keys') {
      if (g.started) useProject.getState().sealHistory()
      else if (g.collapseTo) useUi.getState().selectKeys([g.collapseTo])
    }
    if (g.kind === 'move') {
      if (g.started && g.moves) {
        const ops = planMove(useProject.getState().project, g.moves, { rippleInsert: p.alt })
        if (ops && ops.length > 0) useProject.getState().dispatch(ops, { label: 'Перемещение' })
      } else if (!g.started && g.collapseTo) {
        useUi.getState().select([g.collapseTo])
      }
    }
    this.overlay = { ...emptyOverlay(), bladeX: this.overlay.bladeX }
    this.host.redraw()
  }

  cancel(): void {
    const g = this.gesture
    if (g?.kind === 'trim' || ((g?.kind === 'marker' || g?.kind === 'keys') && g.started))
      useProject.getState().sealHistory()
    this.gesture = null
    this.overlay = emptyOverlay()
    this.host.redraw()
  }

  hover(p: PointerInfo): void {
    const v = this.view()
    const hit = hitTest(this.rows(), v, p.x, p.y)
    const tool = useUi.getState().tool
    let cursor = 'default'
    if (hitKey(this.keys(), p.x, p.y) || hitMarker(this.markers(), p.x, p.y)) cursor = 'pointer'
    else if (hit.area === 'ruler') cursor = 'text'
    else if (tool === 'blade' && hit.area === 'item') cursor = 'crosshair'
    else if (hit.area === 'item' && !hit.row.track.locked) cursor = hit.zone === 'body' ? 'grab' : 'ew-resize'
    this.host.setCursor(cursor)
    const bladeX = tool === 'blade' && hit.area === 'item' ? p.x : null
    if (bladeX !== this.overlay.bladeX) {
      this.overlay.bladeX = bladeX
      this.host.redraw()
    }
  }

  leave(): void {
    if (this.overlay.bladeX !== null) {
      this.overlay.bladeX = null
      this.host.redraw()
    }
  }

  // --- колесо ---

  wheel(e: { x: number; deltaX: number; deltaY: number; ctrl: boolean; shift: boolean }): void {
    const ui = useUi.getState()
    const v = this.view()
    if (e.ctrl) {
      const factor = Math.exp(-e.deltaY * 0.0015)
      ui.zoomAt(ui.pxPerSec * factor, xToTime(e.x, v), e.x)
    } else if (e.shift) {
      const max = maxScrollY(this.rows(), v)
      ui.setScroll(ui.scrollX, Math.min(max, Math.max(0, ui.scrollY + e.deltaY)))
    } else {
      const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY
      ui.setScroll(ui.scrollX + d / ui.pxPerSec)
    }
  }

  // --- drop ассета из Media Bin ---

  private dropPlan(x: number, y: number, assetId: string, shift: boolean) {
    const asset = useAssets.getState().assets[assetId]
    if (!asset || asset.status !== 'ready') return null
    const project = useProject.getState().project
    const v = this.view()
    const duration = assetClipDuration(asset, project.fps)
    this.dropTargets ??= this.targets([])
    const snapped = snapSpan(Math.max(0, xToTime(x, v)), duration, this.dropTargets, this.snapOpts(shift))
    const row = rowAtY(this.rows(), y, v)
    const span = { start: snapped.value, end: snapped.value + duration }
    const track = pickTrackForAsset(project, asset, span, row?.track.id)
    return {
      asset,
      project,
      start: snapped.value,
      duration,
      snapAt: snapped.snappedAt,
      track,
      hoveredId: row?.track.id,
    }
  }

  dragOver(x: number, y: number, assetId: string, shift: boolean): boolean {
    const plan = this.dropPlan(x, y, assetId, shift)
    if (!plan) return false
    this.overlay.dropGhost = {
      start: plan.start,
      duration: plan.duration,
      trackId: plan.track?.id ?? null,
      label: plan.asset.name,
    }
    this.overlay.snapAt = plan.snapAt
    this.host.redraw()
    return true
  }

  drop(x: number, y: number, assetId: string, shift: boolean): void {
    const plan = this.dropPlan(x, y, assetId, shift)
    this.dragLeave()
    if (!plan) return
    const ops = planAssetDrop(plan.project, plan.asset, {
      start: plan.start,
      ...(plan.hoveredId ? { trackId: plan.hoveredId } : {}),
    })
    const res = useProject.getState().dispatch(ops, { label: 'Добавить клип' })
    if (res.ok) {
      const clips = res.created.filter((id) => id.startsWith('clp_'))
      useUi.getState().select(clips)
      // новый аудиоклип: сразу запускаем анализ музыки (или применяем готовый)
      if (plan.asset.kind === 'audio') autoAnalyzeClips(clips)
    }
  }

  // --- drop эффекта из библиотеки ---

  /** Куда ляжет эффект/пресет, брошенный в точку (x, y): клип видеодорожки, fx-дорожка или новая fx-дорожка. */
  private effectTargetAt(x: number, y: number, shift: boolean) {
    const v = this.view()
    this.dropTargets ??= this.targets([])
    const snapped = snapPoint(Math.max(0, xToTime(x, v)), this.dropTargets, this.snapOpts(shift))
    const hit = hitTest(this.rows(), v, x, y)
    let target: EffectDropTarget = 'newFxTrack'
    let trackId: string | null = null
    if (hit.area === 'item' && isClip(hit.item) && hit.row.track.kind === 'video') {
      target = { clipId: hit.item.id }
      trackId = hit.row.track.id
    } else if ((hit.area === 'item' || hit.area === 'track') && hit.row.track.kind === 'fx') {
      target = { trackId: hit.row.track.id }
      trackId = hit.row.track.id
    }
    return { target, trackId, t: snapped.value, snapAt: snapped.snappedAt }
  }

  private effectDropPlan(x: number, y: number, effectId: string, shift: boolean) {
    const def = getEffectDef(effectId)
    if (!def) return null
    return { def, ...this.effectTargetAt(x, y, shift) }
  }

  /** Бросок перехода: ближайший стык (не дальше TRANSITION_SNAP_PX) на видеодорожке под курсором или на любой. */
  private transitionDropPlan(x: number, y: number, effectId: string) {
    const def = getEffectDef(effectId)
    if (!def) return null
    const v = this.view()
    const project = useProject.getState().project
    const row = rowAtY(this.rows(), y, v)
    const cut = nearestCut(
      project,
      xToTime(x, v),
      TRANSITION_SNAP_PX / v.pxPerSec,
      row?.track.kind === 'video' ? row.track.id : undefined,
    )
    if (!cut) return null
    try {
      const target = planTransitions(project, effectId, [cut]).targets[0]!
      return { def, cut, span: target.spans[0]!, trackId: target.fxTrackId ?? target.videoTrackId }
    } catch (e) {
      if (e instanceof OpsError) return null
      throw e
    }
  }

  effectDragOver(x: number, y: number, effectId: string, shift: boolean): boolean {
    if (isTransition(effectId)) {
      const tp = this.transitionDropPlan(x, y, effectId)
      if (!tp) {
        if (this.overlay.dropGhost) this.dragLeave()
        return false
      }
      this.overlay.dropGhost = { ...tp.span, trackId: tp.trackId, label: tp.def.name }
      this.overlay.snapAt = tp.cut.t
      this.host.redraw()
      return true
    }
    const plan = this.effectDropPlan(x, y, effectId, shift)
    if (!plan) return false
    this.overlay.dropGhost = {
      start: plan.t,
      duration: plan.def.defaultDuration,
      trackId: plan.trackId,
      label: plan.def.name,
    }
    this.overlay.snapAt = plan.snapAt
    this.host.redraw()
    return true
  }

  effectDrop(x: number, y: number, effectId: string, shift: boolean): void {
    if (isTransition(effectId)) {
      const tp = this.transitionDropPlan(x, y, effectId)
      this.dragLeave()
      if (tp) addTransitions(effectId, [tp.cut])
      return
    }
    const plan = this.effectDropPlan(x, y, effectId, shift)
    this.dragLeave()
    if (plan) dropEffect(effectId, plan.target, plan.t)
  }

  // --- drop пресета-комбо ---

  presetDragOver(x: number, y: number, presetId: string, shift: boolean): boolean {
    const preset = findPreset(presetId)
    if (!preset) return false
    const plan = this.effectTargetAt(x, y, shift)
    this.overlay.dropGhost = {
      start: plan.t,
      duration: presetSpan(preset),
      trackId: plan.trackId,
      label: preset.name,
    }
    this.overlay.snapAt = plan.snapAt
    this.host.redraw()
    return true
  }

  presetDrop(x: number, y: number, presetId: string, shift: boolean): void {
    const plan = this.effectTargetAt(x, y, shift)
    this.dragLeave()
    dropPreset(presetId, plan.target, plan.t)
  }

  dragLeave(): void {
    this.dropTargets = null
    this.overlay.dropGhost = null
    this.overlay.snapAt = null
    this.host.redraw()
  }
}
