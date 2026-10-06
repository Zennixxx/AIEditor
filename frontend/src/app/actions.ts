// Команды редактора — общие для горячих клавиш и кнопок. Логика изменений — в model/, здесь только связка со сторами.
import { copyItems, planDelete, planPaste, planSplitAt } from '@/model/edit'
import { allClips, findClip, findItem, findMarker } from '@/model/lookup'
import { planRippleTrack } from '@/model/ripple'
import { neighborMarkerTime, planAddMarker, planDeleteMarkers, timelineMarkers } from '@/model/markers'
import { trackInput } from '@/model/project'
import { newTrackIndex } from '@/model/tracks'
import type { Animatable, Ease, EditOp, EffectPatch, TimeRemap, TrackKind } from '@/shared/types.gen'
import { EPS } from '@/model/clipTime'
import { constantRamp } from '@/model/rampKeys'
import { planVelocity } from '@/model/velocity'
import { findRampPreset } from '@/shared/rampPresets'
import type { ApplyFxOp } from '@/model/applyEffectToMarkers'
import type { CutOp } from '@/model/cutToMarkers'
import { planEffectDrop, type EffectDropTarget } from '@/model/effects'
import { findCuts, planTransitions, type Cut } from '@/model/transitions'
import { planPresetDrop } from '@/model/presets'
import { clipKeyTimes, laneIsAnimated, planKeysEase, planRemoveKeys } from '@/model/clipKeys'
import {
  animPatch,
  clipAnimatable,
  evaluateAnimatable,
  keyAt,
  keyTimes,
  LANE_PROPS,
  neighborKey,
  removeKey,
  setKey,
  setKeyEase,
  setValueAt,
  toggleAnimation,
  type AnimProp,
} from '@/model/keyframes'
import { player } from '@/playback/player'
import { findPreset } from '@/store/presets'
import { OpsError } from '@/model/ops/errors'
import { useProject, type DispatchResult } from '@/store/project'
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
  // выделенные ключевые кадры и маркеры удаляются раньше элементов дорожек
  const keys = ui().keySelection
  if (keys.length > 0) {
    const ops = planRemoveKeys(project(), keys)
    ui().selectKeys([])
    if (ops.length > 0) {
      useProject.getState().dispatch(ops, { label: 'Удалить ключи' })
      return
    }
  }
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

/** Переход на стыки `cuts`; новые переходы становятся выделением. Ошибка — в lastError стора проекта. */
export function addTransitions(effectId: string, cuts: readonly Cut[]): boolean {
  let ops
  try {
    ops = planTransitions(project(), effectId, cuts).ops
  } catch (e) {
    if (e instanceof OpsError) {
      useProject.setState({ lastError: e.message })
      return false
    }
    throw e
  }
  const res = useProject.getState().dispatch(ops, {
    label: cuts.length > 1 ? 'Переходы на стыки' : 'Добавить переход',
  })
  if (res.ok) ui().select(res.created.filter((id) => id.startsWith('fx_')))
  return res.ok
}

/** Переход на все стыки выделенных клипов (ничего не выделено — на все стыки видеодорожек). */
export function transitionsAtCuts(effectId: string): boolean {
  const p = project()
  const clips = liveSelection().filter((id) => findClip(p, id))
  return addTransitions(effectId, findCuts(p, clips.length > 0 ? new Set(clips) : undefined))
}

/** Пресет-комбо брошен на таймлайн; ошибка — в lastError стора проекта. */
export function dropPreset(presetId: string, target: EffectDropTarget, t: number): boolean {
  const preset = findPreset(presetId)
  if (!preset) return false
  let ops
  try {
    ops = planPresetDrop(project(), preset, target, t)
  } catch (e) {
    if (e instanceof OpsError) {
      useProject.setState({ lastError: e.message })
      return false
    }
    throw e
  }
  const res = useProject.getState().dispatch(ops, { label: `Пресет «${preset.name}»` })
  if (!res.ok) return false
  if (typeof target === 'object' && 'clipId' in target) ui().select([target.clipId])
  else {
    const p = project()
    ui().select(res.created.filter((id) => id.startsWith('fx_') && findItem(p, id)))
  }
  return true
}

/** `U`: показать дорожки анимированных свойств выделенных клипов (ничего не выделено — всех), повторно — скрыть. */
export function toggleAnimatedLanes(): void {
  if (ui().propLanes.length > 0) {
    ui().setLanes([])
    return
  }
  const p = project()
  const selected = new Set(liveSelection())
  const clips = [...allClips(p)].filter((c) => selected.size === 0 || selected.has(c.id))
  ui().setLanes(LANE_PROPS.filter((l) => clips.some((c) => laneIsAnimated(c, l))))
}

// --- ключевые кадры transform/opacity (инспектор клипа) ---

function editAnim(
  clipId: string,
  prop: AnimProp,
  fn: (value: Animatable) => Animatable,
  label: string,
  mergeKey?: string,
): boolean {
  const clip = findClip(project(), clipId)?.clip
  if (!clip) return false
  const before = clipAnimatable(clip, prop)
  const after = fn(before)
  if (after === before) return false
  return useProject.getState().dispatch([{ op: 'updateClip', clipId, patch: animPatch(clip, prop, after) }], {
    label,
    ...(mergeKey ? { mergeKey: `anim:${clipId}:${prop}:${mergeKey}` } : {}),
  }).ok
}

/** Значение свойства во время `t` от начала клипа (у анимированного — ключ, как автоключ в AE). */
export function setAnimValue(
  clipId: string,
  prop: AnimProp,
  t: number,
  v: number,
  mergeKey?: string,
): boolean {
  return editAnim(clipId, prop, (a) => setValueAt(a, t, v), 'Свойство клипа', mergeKey)
}

/** «Секундомер»: включить/выключить анимацию свойства. */
export function toggleAnim(clipId: string, prop: AnimProp, t: number): boolean {
  return editAnim(clipId, prop, (a) => toggleAnimation(a, t), 'Анимация свойства')
}

/** Ключ во время `t`: есть — удалить, нет — поставить с текущим значением. */
export function toggleKey(clipId: string, prop: AnimProp, t: number): boolean {
  return editAnim(
    clipId,
    prop,
    (a) => (keyAt(a, t) ? removeKey(a, t) : setKey(a, t, evaluateAnimatable(a, t))),
    'Ключевой кадр',
  )
}

/** Интерполяция ключей: выделенных на дорожках свойств, иначе — ключа `prop` во время `t`. */
export function setKeysEase(clipId: string, prop: AnimProp, t: number, ease: Ease): boolean {
  const sel = ui().keySelection
  if (sel.length > 0) {
    const ops = planKeysEase(project(), sel, ease)
    return ops.length > 0 && useProject.getState().dispatch(ops, { label: 'Интерполяция ключей' }).ok
  }
  return editAnim(clipId, prop, (a) => setKeyEase(a, t, ease), 'Интерполяция ключа')
}

/** Плейхед к соседнему ключу клипа (`prop` — по одному свойству, иначе по всем). */
export function gotoKey(clipId: string, dir: 1 | -1, prop?: AnimProp): void {
  const clip = findClip(project(), clipId)?.clip
  if (!clip) return
  const times = prop ? keyTimes(clipAnimatable(clip, prop)) : clipKeyTimes(clip)
  const t = neighborKey(times, ui().playhead - clip.start, dir)
  if (t !== null) ui().setPlayhead(clip.start + t)
}

export function setInAtPlayhead(): void {
  ui().setInPoint(ui().playhead)
}

export function setOutAtPlayhead(): void {
  ui().setOutPoint(ui().playhead)
}

export function clearInOut(): void {
  ui().setInPoint(null)
  ui().setOutPoint(null)
}

export function openExportDialog(): void {
  player.pause()
  ui().setExportDialogOpen(true)
}

// --- скорость и speed ramp ---

function dispatchClip(ops: EditOp[], label: string, mergeKey?: string): DispatchResult {
  return useProject.getState().dispatch(ops, { label, ...(mergeKey ? { mergeKey } : {}) })
}

function nextItemStart(clipId: string): number {
  const ref = findClip(project(), clipId)
  if (!ref) return Infinity
  const next = ref.track.items.find((i) => i.start > ref.clip.start + EPS && i.id !== clipId)
  return next ? next.start : Infinity
}

export function setClipSpeed(clipId: string, speed: number, mergeKey?: string): DispatchResult | null {
  const clip = findClip(project(), clipId)?.clip
  if (!clip || !(speed > 0)) return null
  const range = clip.sourceOut - clip.sourceIn
  const room = nextItemStart(clipId) - clip.start
  const duration = Math.min(range / speed, room)
  return dispatchClip(
    [{ op: 'updateClip', clipId, patch: { speed, duration, sourceOut: clip.sourceIn + duration * speed } }],
    'Скорость клипа',
    mergeKey ? `speed:${clipId}:${mergeKey}` : undefined,
  )
}

export function setClipReverse(clipId: string, reverse: boolean): DispatchResult {
  return dispatchClip([{ op: 'updateClip', clipId, patch: { reverse } }], 'Обратное воспроизведение')
}

export function setTimeRemap(clipId: string, timeRemap: TimeRemap | null, mergeKey?: string): DispatchResult {
  return dispatchClip(
    [{ op: 'setTimeRemap', clipId, timeRemap }],
    timeRemap ? 'Кривая скорости' : 'Постоянная скорость',
    mergeKey ? `ramp:${clipId}:${mergeKey}` : undefined,
  )
}

export function enableSpeedCurve(clipId: string): DispatchResult | null {
  const clip = findClip(project(), clipId)?.clip
  if (!clip || clip.timeRemap) return null
  return setTimeRemap(clipId, constantRamp(clip.speed))
}

export function applyRampPreset(clipId: string, presetId: string): DispatchResult | null {
  const preset = findRampPreset(presetId)
  const clip = findClip(project(), clipId)?.clip
  if (!preset || !clip) return null
  return setTimeRemap(clipId, {
    ...structuredClone(preset.timeRemap),
    frameBlend: clip.timeRemap?.frameBlend ?? true,
  })
}

export function velocityBetweenMarkers(
  clipId: string,
  presetId: string,
): { result: DispatchResult; matched: number } | null {
  const preset = findRampPreset(presetId)
  const p = project()
  const clip = findClip(p, clipId)?.clip
  if (!preset || !clip) return null
  const times = timelineMarkers(p, ui().markerVisibility)
    .filter((m) => m.clipId !== clipId)
    .map((m) => m.t)
  const { ops, matched } = planVelocity(clip, preset.timeRemap, times, p.fps)
  return { result: dispatchClip(ops, 'Velocity между маркерами'), matched }
}

export function toggleCurveEditor(): void {
  if (ui().curveEditorClipId) {
    ui().openCurveEditor(null)
    return
  }
  const p = project()
  const id = liveSelection().find((s) => findClip(p, s)?.track.kind === 'video')
  if (id) ui().openCurveEditor(id)
}
