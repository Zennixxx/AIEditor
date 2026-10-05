// Команды редактора — общие для горячих клавиш и кнопок. Логика изменений — в model/, здесь только связка со сторами.
import { copyItems, planDelete, planPaste, planSplitAt } from '@/model/edit'
import { findClip, findItem, findMarker } from '@/model/lookup'
import { planRippleTrack } from '@/model/ripple'
import { neighborMarkerTime, planAddMarker, planDeleteMarkers, timelineMarkers } from '@/model/markers'
import { trackInput } from '@/model/project'
import { newTrackIndex } from '@/model/tracks'
import type { EffectPatch, TrackKind } from '@/shared/types.gen'
import type { ApplyFxOp } from '@/model/applyEffectToMarkers'
import type { CutOp } from '@/model/cutToMarkers'
import { planEffectDrop, type EffectDropTarget } from '@/model/effects'
import { OpsError } from '@/model/ops/errors'
import { useProject } from '@/store/project'
import { useUi } from '@/store/ui'
import { fitZoom, followPlayhead, timeToX } from '@/timeline/geometry'

const project = () => useProject.getState().project
const ui = () => useUi.getState()

/** Оставить в выделении только существующие элементы (после undo/удаления). */
export function liveSelection(): string[] {
  const p = project()
  return ui().selection.filter((id) => findItem(p, id))
}

export function undo(): void {
  useProject.getState().undo()
}

export function redo(): void {
  useProject.getState().redo()
}

export function splitAtPlayhead(): void {
  const ops = planSplitAt(project(), ui().playhead, liveSelection())
  useProject.getState().dispatch(ops, { label: 'Разрезать' })
}

/** Оставить в выделении только существующие маркеры. */
export function liveMarkerSelection(): string[] {
  const p = project()
  return ui().markerSelection.filter((id) => findMarker(p, id))
}

/** `M`: маркер под плейхедом: на выделенный аудиоклип, иначе маркер проекта. Работает и при воспроизведении. */
export function addMarkerAtPlayhead(): void {
  const ops = planAddMarker(project(), ui().playhead, liveSelection())
  const res = useProject.getState().dispatch(ops, { label: 'Маркер' })
  if (res.ok) ui().selectMarkers(res.created.filter((id) => id.startsWith('mrk_')))
}

/** `Shift+←/→`: плейхед к предыдущему/следующему видимому маркеру (скрытые фильтром пропускаются). */
export function gotoMarker(dir: 1 | -1): void {
  const list = timelineMarkers(project(), ui().markerVisibility)
  const t = neighborMarkerTime(list, ui().playhead, dir)
  if (t === null) return
  ui().setPlayhead(t) // плеер подхватывает внешний seek сам (как при скрабе по линейке)
  const { pxPerSec, scrollX, viewWidth } = ui()
  const x = followPlayhead({ pxPerSec, scrollX, width: viewWidth }, t)
  if (x !== scrollX) ui().setScroll(x)
}

export function deleteSelection(ripple: boolean): void {
  // выделенные маркеры удаляются раньше элементов дорожек
  const markers = liveMarkerSelection()
  if (markers.length > 0) {
    const res = useProject.getState().dispatch(planDeleteMarkers(project(), markers), {
      label: 'Удалить маркеры',
    })
    if (res.ok) ui().selectMarkers([])
    return
  }
  const ops = planDelete(project(), liveSelection(), ripple)
  const res = useProject.getState().dispatch(ops, { label: ripple ? 'Удалить со сдвигом' : 'Удалить' })
  if (res.ok) ui().select([])
}

export function selectAll(): void {
  const ids = project()
    .tracks.filter((t) => !t.locked)
    .flatMap((t) => t.items.map((i) => i.id))
  ui().select(ids)
}

export function copySelection(): void {
  const entries = copyItems(project(), liveSelection())
  if (entries.length > 0) ui().setClipboard(entries)
}

export function paste(): void {
  const ops = planPaste(project(), ui().clipboard, ui().playhead)
  const res = useProject.getState().dispatch(ops, { label: 'Вставить' })
  if (res.ok) ui().select(res.created.filter((id) => findItem(project(), id)))
}

export function addTrack(kind: TrackKind): void {
  const p = project()
  useProject
    .getState()
    .dispatch([{ op: 'addTrack', track: trackInput(p, kind), index: newTrackIndex(p, kind) }], {
      label: 'Добавить дорожку',
    })
}

export function removeTrack(trackId: string): void {
  useProject.getState().dispatch([{ op: 'removeTrack', trackId }], { label: 'Удалить дорожку' })
}

const ZOOM_STEP = 1.5

function zoomAroundPlayhead(factor: number): void {
  const { pxPerSec, scrollX, viewWidth, playhead } = ui()
  const x = timeToX(playhead, { pxPerSec, scrollX })
  const anchorX = x >= 0 && x <= viewWidth ? x : viewWidth / 2
  const anchorTime = anchorX / pxPerSec + scrollX
  ui().zoomAt(pxPerSec * factor, anchorTime, anchorX)
}

export function zoomIn(): void {
  zoomAroundPlayhead(ZOOM_STEP)
}

export function zoomOut(): void {
  zoomAroundPlayhead(1 / ZOOM_STEP)
}

export function zoomFit(): void {
  const { viewWidth } = ui()
  useUi.setState({ pxPerSec: fitZoom(project().duration, viewWidth), scrollX: 0 })
}

export function toggleSnap(): void {
  ui().setSnap(!ui().snapEnabled)
}

/** Диалог «Нарезать по маркерам» (docs/FRONTEND.md, фаза 3). */
export function openCutDialog(): void {
  ui().setCutDialogOpen(true)
}

/** Применить `cutToMarkers`; новые клипы становятся выделением. */
export function cutToMarkers(op: CutOp): boolean {
  const res = useProject.getState().dispatch([op], { label: 'Нарезать по маркерам' })
  if (res.ok) ui().select(res.created.filter((id) => id.startsWith('clp_')))
  return res.ok
}

/** Максимальный сдвиг края клипа при «К маркерам», сек. */
export const SNAP_EDGES_MAX_SHIFT = 0.25

/**
 * Края выделенных клипов — к ближайшим видимым маркерам (виды и порог — из фильтра видимости
 * маркеров, но не шире, чем показывает таймлайн).
 */
export function snapSelectedEdgesToMarkers(): void {
  const clipIds = liveSelection().filter((id) => findClip(project(), id))
  if (clipIds.length === 0) return
  const { kinds, minStrength } = ui().markerVisibility
  useProject.getState().dispatch(
    [
      {
        op: 'snapClipEdgesToMarkers',
        clipIds,
        filter: { kinds: [...kinds], minStrength },
        maxShift: SNAP_EDGES_MAX_SHIFT,
      },
    ],
    { label: 'Края клипов к маркерам' },
  )
}

/** Сомкнуть пробелы между элементами дорожки (первый элемент остаётся на месте). */
export function rippleTrack(trackId: string): void {
  useProject.getState().dispatch(planRippleTrack(project(), trackId), { label: 'Сомкнуть пробелы' })
}

/** Диалог «Эффект по маркерам» (docs/FRONTEND.md, фаза 4). */
export function openFxDialog(effect = 'shake'): void {
  ui().openFxDialog(effect)
}

/** Применить `applyEffectToMarkers`; новые эффекты fx-дорожки становятся выделением. */
export function applyEffectToMarkers(op: ApplyFxOp): boolean {
  const res = useProject.getState().dispatch([op], { label: 'Эффект по маркерам' })
  if (res.ok) {
    const p = project()
    ui().select(res.created.filter((id) => id.startsWith('fx_') && findItem(p, id)))
  }
  return res.ok
}

/** Эффект из библиотеки брошен на таймлайн; ошибка (место занято) — в lastError стора проекта. */
export function dropEffect(effectId: string, target: EffectDropTarget, t: number): boolean {
  let ops
  try {
    ops = planEffectDrop(project(), effectId, target, t)
  } catch (e) {
    if (e instanceof OpsError) {
      useProject.setState({ lastError: e.message })
      return false
    }
    throw e
  }
  const res = useProject.getState().dispatch(ops, { label: 'Добавить эффект' })
  if (!res.ok) return false
  const fx = res.created.find((id) => id.startsWith('fx_'))
  if (fx) {
    if (typeof target === 'object' && 'clipId' in target) {
      ui().select([target.clipId])
      ui().inspectEffect(fx)
    } else ui().select([fx])
  }
  return true
}

/** Правка эффекта из инспектора: непрерывный ввод (`mergeKey`) склеивается в одну запись истории. */
export function updateEffect(effectId: string, patch: EffectPatch, mergeKey?: string): boolean {
  return useProject.getState().dispatch([{ op: 'updateEffect', effectId, patch }], {
    label: 'Правка эффекта',
    ...(mergeKey ? { mergeKey: `fx-edit:${effectId}:${mergeKey}` } : {}),
  }).ok
}

export function removeEffect(effectId: string): void {
  useProject.getState().dispatch([{ op: 'removeEffect', effectId }], { label: 'Удалить эффект' })
}
