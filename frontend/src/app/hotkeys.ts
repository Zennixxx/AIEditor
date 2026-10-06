// Глобальные горячие клавиши редактора: команды из keymap.ts с клавишами пользователя.
import { player } from '@/playback/player'
import { saveNow } from '@/store/projectIo'
import { useUi } from '@/store/ui'
import * as actions from './actions'
import { bindingFromEvent, commandFor } from './keymap'

/** Ползунки, флажки и т. п. не вводят текст: горячие клавиши работают, даже если фокус остался на них. */
const NON_TEXT_INPUTS = new Set(['range', 'checkbox', 'radio', 'button', 'color'])

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target instanceof HTMLInputElement && NON_TEXT_INPUTS.has(target.type)) return false
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
}

const lane = (l: Parameters<ReturnType<typeof useUi.getState>['toggleLane']>[0]) => () =>
  useUi.getState().toggleLane(l)

export const HOTKEY_ACTIONS: Record<string, () => void> = {
  undo: actions.undo,
  redo: actions.redo,
  split: actions.splitAtPlayhead,
  selectAll: actions.selectAll,
  copy: actions.copySelection,
  paste: actions.paste,
  delete: () => actions.deleteSelection(false),
  rippleDelete: () => actions.deleteSelection(true),
  escape: () => {
    const ui = useUi.getState()
    ui.select([])
    ui.selectMarkers([])
    ui.selectKeys([])
    ui.setTool('select')
  },
  toolSelect: () => useUi.getState().setTool('select'),
  toolBlade: () => useUi.getState().setTool('blade'),
  playPause: () => player.toggle(),
  shuttleBack: () => player.shuttle(-1),
  stop: () => player.pause(),
  shuttleForward: () => player.shuttle(1),
  frameBack: () => player.step(-1),
  frameForward: () => player.step(1),
  home: () => player.home(),
  end: () => player.end(),
  setIn: actions.setInAtPlayhead,
  setOut: actions.setOutAtPlayhead,
  clearInOut: actions.clearInOut,
  addMarker: actions.addMarkerAtPlayhead,
  prevMarker: () => actions.gotoMarker(-1),
  nextMarker: () => actions.gotoMarker(1),
  toggleSnap: actions.toggleSnap,
  zoomIn: actions.zoomIn,
  zoomOut: actions.zoomOut,
  zoomFit: actions.zoomFit,
  lanePosition: lane('position'),
  laneScale: lane('scale'),
  laneRotation: lane('rotation'),
  laneOpacity: lane('opacity'),
  lanesAnimated: actions.toggleAnimatedLanes,
  curveEditor: actions.toggleCurveEditor,
  hotkeys: () => useUi.getState().setModal('hotkeys'),
  projects: () => useUi.getState().setModal('projects'),
  settings: () => useUi.getState().setModal('settings'),
  save: () => void saveNow(),
  export: actions.openExportDialog,
}

export function handleHotkey(e: KeyboardEvent): boolean {
  const ui = useUi.getState()
  // модальный диалог владеет клавиатурой
  if (isTyping(e.target) || ui.cutDialogOpen || ui.exportDialogOpen || ui.modal) return false
  const binding = bindingFromEvent(e)
  if (!binding) return false
  const cmd = commandFor(binding)
  if (!cmd) return false
  if (cmd.noRepeat && e.repeat) return true
  HOTKEY_ACTIONS[cmd.id]?.()
  return true
}

export function installHotkeys(): () => void {
  const onKey = (e: KeyboardEvent) => {
    if (handleHotkey(e)) e.preventDefault()
  }
  // Space на кнопке в фокусе «нажимает» её на keyup — для транспорта это не нужно
  const onKeyUp = (e: KeyboardEvent) => {
    if (e.code === 'Space' && !isTyping(e.target)) e.preventDefault()
  }
  window.addEventListener('keydown', onKey)
  window.addEventListener('keyup', onKeyUp)
  return () => {
    window.removeEventListener('keydown', onKey)
    window.removeEventListener('keyup', onKeyUp)
  }
}
