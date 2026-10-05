// Команды редактора — общие для горячих клавиш и кнопок. Логика изменений — в model/, здесь только связка со сторами.
import { copyItems, planDelete, planPaste, planSplitAt } from '@/model/edit'
import { findItem, findMarker } from '@/model/lookup'
import { neighborMarkerTime, planAddMarker, planDeleteMarkers, timelineMarkers } from '@/model/markers'
import { trackInput } from '@/model/project'
import { newTrackIndex } from '@/model/tracks'
import type { TrackKind } from '@/shared/types.gen'
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
