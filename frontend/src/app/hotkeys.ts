// Глобальные горячие клавиши редактора (фаза 1a: правка таймлайна; воспроизведение — 1b).
import { useUi } from '@/store/ui'
import * as actions from './actions'

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
}

export function handleHotkey(e: KeyboardEvent): boolean {
  if (isTyping(e.target)) return false
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

  if (key === 'delete' || key === 'backspace') {
    actions.deleteSelection(e.shiftKey)
    return true
  }
  if (code === 'KeyC') return run(() => useUi.getState().setTool('blade'))
  if (code === 'KeyV') return run(() => useUi.getState().setTool('select'))
  if (code === 'KeyS') return run(actions.toggleSnap)
  if (key === '+' || key === '=' || code === 'NumpadAdd') return run(actions.zoomIn)
  if (key === '-' || key === '_' || code === 'NumpadSubtract') return run(actions.zoomOut)
  if (key === '\\' || code === 'Backslash') return run(actions.zoomFit)
  if (key === 'escape') {
    useUi.getState().select([])
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
  window.addEventListener('keydown', onKey)
  return () => window.removeEventListener('keydown', onKey)
}
