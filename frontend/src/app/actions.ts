// Команды редактора — общие для горячих клавиш и кнопок. Логика изменений — в model/, здесь только связка со сторами.
import { copyItems, planDelete, planPaste, planSplitAt } from '@/model/edit'
import { findItem } from '@/model/lookup'
import { trackInput } from '@/model/project'
import { newTrackIndex } from '@/model/tracks'
import type { TrackKind } from '@/shared/types.gen'
import { useProject } from '@/store/project'
import { useUi } from '@/store/ui'
import { fitZoom, timeToX } from '@/timeline/geometry'

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

export function deleteSelection(ripple: boolean): void {
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
