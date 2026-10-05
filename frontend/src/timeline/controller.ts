// Инструменты взаимодействия с таймлайном: скраб, выделение (клик/рамка), перемещение, трим, лезвие,
// drop ассета из Media Bin, зум/скролл. Состояние жестов — здесь; проект меняется только через dispatch.
import { planAssetDrop, planMove, planTrim, pickTrackForAsset, type ItemMove } from '@/model/edit'
import { isClip } from '@/model/lookup'
import { assetClipDuration } from '@/model/project'
import { collectSnapTargets, snapPoint, snapSpan, snapThreshold, type SnapTarget } from '@/model/snapping'
import { snapToFrame } from '@/shared/time'
import type { Project, Track, TrackItem } from '@/shared/types.gen'
import { useAssets } from '@/store/assets'
import { useProject } from '@/store/project'
import { useUi } from '@/store/ui'
import {
  hitTest,
  itemsInRect,
  layoutTracks,
  maxScrollY,
  rowAtY,
  xToTime,
  type TrackRow,
  type View,
} from './geometry'
import { emptyOverlay, type Overlay } from './render'

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

const DRAG_THRESHOLD_PX = 3
let gestureSeq = 0

export interface ControllerHost {
  size: () => { width: number; height: number }
  redraw: () => void
  setCursor: (cursor: string) => void
}

export class TimelineController {
  overlay: Overlay = emptyOverlay()
  private gesture: Gesture | null = null
  private rowsCache: { project: Project; rows: TrackRow[] } | null = null
  private dropTargets: SnapTarget[] | null = null

  constructor(private readonly host: ControllerHost) {}

  view(): View {
    const { pxPerSec, scrollX, scrollY } = useUi.getState()
    const { width, height } = this.host.size()
    return { pxPerSec, scrollX, scrollY, width, height }
  }

  rows(): TrackRow[] {
    const project = useProject.getState().project
    if (this.rowsCache?.project !== project) this.rowsCache = { project, rows: layoutTracks(project) }
    return this.rowsCache.rows
  }

  private snapOpts(shift: boolean) {
    const ui = useUi.getState()
    return {
      enabled: ui.snapEnabled && !shift,
      threshold: snapThreshold(ui.pxPerSec),
      fps: useProject.getState().project.fps,
    }
  }

  private targets(exclude: Iterable<string>): SnapTarget[] {
    return collectSnapTargets(useProject.getState().project, {
      playhead: useUi.getState().playhead,
      exclude: new Set(exclude),
    })
  }

  // --- указатель ---

  pointerDown(p: PointerInfo): boolean {
    if (p.button !== 0) return false
    const v = this.view()
    const rows = this.rows()
    const hit = hitTest(rows, v, p.x, p.y)
    const ui = useUi.getState()
    const fps = useProject.getState().project.fps

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

    if (hit.area === 'track' || hit.area === 'empty' || hit.area === 'item') {
      const base = p.ctrl || p.shift ? ui.selection : []
      if (!p.ctrl && !p.shift) ui.select([])
      this.gesture = { kind: 'box', x0: p.x, y0: p.y, base }
      return true
    }
    return false
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
    }
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
    if (this.gesture?.kind === 'trim') useProject.getState().sealHistory()
    this.gesture = null
    this.overlay = emptyOverlay()
    this.host.redraw()
  }

  hover(p: PointerInfo): void {
    const v = this.view()
    const hit = hitTest(this.rows(), v, p.x, p.y)
    const tool = useUi.getState().tool
    let cursor = 'default'
    if (hit.area === 'ruler') cursor = 'text'
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
    if (res.ok) useUi.getState().select(res.created.filter((id) => id.startsWith('clp_')))
  }

  dragLeave(): void {
    this.dropTargets = null
    this.overlay.dropGhost = null
    this.overlay.snapAt = null
    this.host.redraw()
  }
}
