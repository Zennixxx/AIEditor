import { beforeEach, describe, expect, it } from 'vitest'
import { allClips } from '@/model/lookup'
import { sampleProject } from '@/model/testUtils'
import { useProject } from '@/store/project'
import { useUi } from '@/store/ui'
import { handleHotkey, HOTKEY_ACTIONS } from './hotkeys'
import {
  bindingFromEvent,
  bindingsOf,
  COMMANDS,
  commandFor,
  formatBinding,
  sameBinding,
  useKeymap,
} from './keymap'

const press = (code: string, mods: Partial<KeyboardEventInit> = {}) =>
  handleHotkey(new KeyboardEvent('keydown', { code, ...mods }))
const clipCount = () => [...allClips(useProject.getState().project)].length

describe('keymap', () => {
  beforeEach(() => {
    localStorage.clear()
    useKeymap.getState().resetAll()
    useProject.getState().load(sampleProject())
    useUi.setState({ selection: [], playhead: 1, modal: null })
  })

  it('every command has an action and default bindings do not collide', () => {
    const seen = new Map<string, string>()
    for (const c of COMMANDS) {
      expect(HOTKEY_ACTIONS[c.id], c.id).toBeTypeOf('function')
      for (const b of c.defaults) {
        const key = formatBinding(b)
        expect(seen.get(key), `${key}: ${c.id} / ${seen.get(key)}`).toBeUndefined()
        seen.set(key, c.id)
      }
    }
  })

  it('reads bindings from events, ignores bare modifiers, formats them', () => {
    expect(bindingFromEvent(new KeyboardEvent('keydown', { code: 'ShiftLeft', shiftKey: true }))).toBeNull()
    const b = bindingFromEvent(new KeyboardEvent('keydown', { code: 'KeyK', ctrlKey: true, shiftKey: true }))
    expect(b).toEqual({ code: 'KeyK', ctrl: true, shift: true })
    expect(formatBinding(b!)).toBe('Ctrl+Shift+K')
    expect(formatBinding({ code: 'ArrowLeft', alt: true })).toBe('Alt+←')
    expect(formatBinding({ code: 'Slash', shift: true })).toBe('Shift+/')
    expect(sameBinding({ code: 'KeyA' }, { code: 'KeyA', ctrl: false })).toBe(true)
    expect(commandFor({ code: 'KeyK', ctrl: true })?.id).toBe('split')
  })

  it('assign rebinds a command, takes the key away from another, persists, and reset restores defaults', () => {
    const taken = useKeymap.getState().assign('split', { code: 'KeyB', ctrl: true })
    expect(taken).toEqual([])
    expect(press('KeyK', { ctrlKey: true })).toBe(false)
    expect(press('KeyB', { ctrlKey: true })).toBe(true)
    expect(clipCount()).toBe(3)
    expect(JSON.parse(localStorage.getItem('aieditor.keymap')!)).toEqual({
      split: [{ code: 'KeyB', ctrl: true }],
    })

    const stolen = useKeymap.getState().assign('addMarker', { code: 'KeyS' })
    expect(stolen).toEqual(['toggleSnap'])
    expect(bindingsOf('toggleSnap')).toEqual([])
    press('KeyS')
    expect(useProject.getState().project.markers).toHaveLength(1)
    expect(useUi.getState().snapEnabled).toBe(true)

    useKeymap.getState().reset('toggleSnap')
    expect(bindingsOf('toggleSnap')).toEqual([{ code: 'KeyS' }])
    useKeymap.getState().resetAll()
    expect(bindingsOf('split')).toEqual([{ code: 'KeyK', ctrl: true }])
    expect(localStorage.getItem('aieditor.keymap')).toBe('{}')
  })

  it('? and window shortcuts open modals; hotkeys are off while a modal is open', () => {
    expect(press('Slash', { shiftKey: true })).toBe(true)
    expect(useUi.getState().modal).toBe('hotkeys')
    expect(press('KeyK', { ctrlKey: true })).toBe(false)
    expect(clipCount()).toBe(2)
    useUi.getState().setModal(null)
    press('Comma', { ctrlKey: true })
    expect(useUi.getState().modal).toBe('settings')
    useUi.getState().setModal(null)
    press('KeyO', { ctrlKey: true })
    expect(useUi.getState().modal).toBe('projects')
  })

  it('noRepeat commands swallow auto-repeat', () => {
    expect(press('KeyM', { repeat: true })).toBe(true)
    expect(useProject.getState().project.markers).toHaveLength(0)
  })
})
