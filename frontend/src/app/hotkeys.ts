// Глобальные горячие клавиши редактора: правка таймлайна и транспорт (Space, J/K/L, ←/→, Home/End).
import { player } from '@/playback/player'
import { useUi } from '@/store/ui'
import * as actions from './actions'

/** Ползунки, флажки и т. п. не вводят текст: горячие клавиши работают, даже если фокус остался на них. */
const NON_TEXT_INPUTS = new Set(['range', 'checkbox', 'radio', 'button', 'color'])

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target instanceof HTMLInputElement && NON_TEXT_INPUTS.has(target.type)) return false
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
}

export function handleHotkey(e: KeyboardEvent): boolean {
  if (isTyping(e.target) || useUi.getState().cutDialogOpen) return false // модальный диалог владеет клавиатурой
  const mod = e.ctrlKey || e.metaKey
  const key = e.key.toLowerCase()
  // e.code — чтобы работало в любой раскладке (Ctrl+K в русской = Ctrl+Л)
  const code = e.code

  if (mod && (code === 'KeyZ' || key === 'z')) {
    if (e.shiftKey) actions.redo()
    else actions.undo()
    return true
  }
  if (mod && (code === 'KeyY' || key === 'y')) return run(actions.redo)
  if (mod && (code === 'KeyK' || key === 'k')) return run(actions.splitAtPlayhead)
  if (mod && (code === 'KeyA' || key === 'a')) return run(actions.selectAll)
  if (mod && (code === 'KeyC' || key === 'c')) return run(actions.copySelection)
  if (mod && (code === 'KeyV' || key === 'v')) return run(actions.paste)
  if (mod || e.altKey) return false

  // транспорт (по e.code — в любой раскладке)
  if (code === 'Space' || key === ' ') return e.repeat || run(() => player.toggle())
  if (code === 'KeyJ') return run(() => player.shuttle(-1))
  if (code === 'KeyK') return run(() => player.pause())
  if (code === 'KeyL') return run(() => player.shuttle(1))
  if (e.shiftKey && key === 'arrowleft') return run(() => actions.gotoMarker(-1))
  if (e.shiftKey && key === 'arrowright') return run(() => actions.gotoMarker(1))
  if (code === 'KeyM') return e.repeat || run(actions.addMarkerAtPlayhead)
  if (!e.shiftKey && key === 'arrowleft') return run(() => player.step(-1))
  if (!e.shiftKey && key === 'arrowright') return run(() => player.step(1))
  if (key === 'home') return run(() => player.home())
  if (key === 'end') return run(() => player.end())

  if (key === 'delete' || key === 'backspace') {
    actions.deleteSelection(e.shiftKey)
    return true
  }
  // дорожки свойств (как в AE): P — позиция, R — поворот, T — непрозрачность, Shift+S — масштаб
  // (S без Shift — привязка), U — анимированные свойства / скрыть все
  if (code === 'KeyP') return run(() => useUi.getState().toggleLane('position'))
  if (code === 'KeyR') return run(() => useUi.getState().toggleLane('rotation'))
  if (code === 'KeyT') return run(() => useUi.getState().toggleLane('opacity'))
  if (e.shiftKey && code === 'KeyS') return run(() => useUi.getState().toggleLane('scale'))
  if (code === 'KeyU') return run(actions.toggleAnimatedLanes)
  if (code === 'KeyC') return run(() => useUi.getState().setTool('blade'))
  if (code === 'KeyV') return run(() => useUi.getState().setTool('select'))
  if (code === 'KeyS') return run(actions.toggleSnap)
  if (key === '+' || key === '=' || code === 'NumpadAdd') return run(actions.zoomIn)
  if (key === '-' || key === '_' || code === 'NumpadSubtract') return run(actions.zoomOut)
  if (key === '\\' || code === 'Backslash') return run(actions.zoomFit)
  if (key === 'escape') {
    useUi.getState().select([])
    useUi.getState().selectMarkers([])
    useUi.getState().selectKeys([])
    useUi.getState().setTool('select')
    return true
  }
  return false
}

function run(fn: () => void): true {
  fn()
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
