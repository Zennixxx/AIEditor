import { beforeEach, describe, expect, it } from 'vitest'
import { allClips } from '@/model/lookup'
import { sampleProject } from '@/model/testUtils'
import { useProject } from '@/store/project'
import { useUi } from '@/store/ui'
import { handleHotkey } from './hotkeys'

const press = (code: string, key: string, mods: Partial<KeyboardEventInit> = {}) =>
  handleHotkey(new KeyboardEvent('keydown', { code, key, ...mods }))
const clipCount = () => [...allClips(useProject.getState().project)].length

describe('hotkeys', () => {
  beforeEach(() => {
    useProject.getState().load(sampleProject())
    useUi.setState({ selection: [], playhead: 1, tool: 'select', snapEnabled: true, clipboard: [] })
  })

  it('Ctrl+K splits under the playhead, Ctrl+Z / Ctrl+Shift+Z undo and redo', () => {
    expect(press('KeyK', 'k', { ctrlKey: true })).toBe(true)
    expect(clipCount()).toBe(3)
    press('KeyZ', 'z', { ctrlKey: true })
    expect(clipCount()).toBe(2)
    press('KeyZ', 'Z', { ctrlKey: true, shiftKey: true })
    expect(clipCount()).toBe(3)
  })

  it('works in the Russian layout (by physical key)', () => {
    press('KeyK', 'л', { ctrlKey: true })
    expect(clipCount()).toBe(3)
  })

  it('Delete removes the selection, Shift+Delete ripples', () => {
    useUi.getState().select(['clp_a'])
    press('Delete', 'Delete', { shiftKey: true })
    expect(clipCount()).toBe(1)
    expect([...allClips(useProject.getState().project)][0]!.start).toBe(0)
  })

  it('Ctrl+A selects all, Ctrl+C / Ctrl+V pastes at the playhead', () => {
    press('KeyA', 'a', { ctrlKey: true })
    expect(useUi.getState().selection).toEqual(['clp_a', 'clp_b', 'fx_shake'])
    useUi.getState().select(['clp_a'])
    press('KeyC', 'c', { ctrlKey: true })
    useUi.setState({ playhead: 4 })
    press('KeyV', 'v', { ctrlKey: true })
    expect(clipCount()).toBe(3)
    expect(useUi.getState().selection).toHaveLength(1)
  })

  it('C / V switch tools, S toggles snapping, zoom keys change px/sec', () => {
    press('KeyC', 'c')
    expect(useUi.getState().tool).toBe('blade')
    press('KeyV', 'v')
    expect(useUi.getState().tool).toBe('select')
    press('KeyS', 's')
    expect(useUi.getState().snapEnabled).toBe(false)
    const z = useUi.getState().pxPerSec
    press('Equal', '+')
    expect(useUi.getState().pxPerSec).toBeGreaterThan(z)
    press('Minus', '-')
    expect(useUi.getState().pxPerSec).toBeCloseTo(z)
  })

  it('Space toggles playback, Home/End jump, arrows step one frame', () => {
    press('Space', ' ')
    expect(useUi.getState().playing).toBe(true)
    press('Space', ' ')
    expect(useUi.getState().playing).toBe(false)
    press('End', 'End')
    expect(useUi.getState().playhead).toBe(4) // длительность sampleProject
    press('Home', 'Home')
    expect(useUi.getState().playhead).toBe(0)
    press('ArrowRight', 'ArrowRight')
    press('ArrowRight', 'ArrowRight')
    expect(useUi.getState().playhead).toBeCloseTo(2 / 30)
    press('ArrowLeft', 'ArrowLeft')
    expect(useUi.getState().playhead).toBeCloseTo(1 / 30)
    press('ArrowLeft', 'ArrowLeft')
    press('ArrowLeft', 'ArrowLeft')
    expect(useUi.getState().playhead).toBe(0) // не уходит в минус
  })

  it('J/K/L shuttle: repeated L doubles the rate, J plays backwards, K stops', () => {
    useUi.setState({ playhead: 2 })
    press('KeyL', 'l')
    expect(useUi.getState()).toMatchObject({ playing: true, playRate: 1 })
    press('KeyL', 'д') // русская раскладка — по физической клавише
    expect(useUi.getState().playRate).toBe(2)
    press('KeyJ', 'j')
    expect(useUi.getState()).toMatchObject({ playing: true, playRate: -1 })
    press('KeyK', 'k')
    expect(useUi.getState().playing).toBe(false)
    // K без Ctrl не режет клипы
    expect(clipCount()).toBe(2)
  })

  it('Space at the end restarts from the beginning', () => {
    useUi.setState({ playhead: 4 })
    press('Space', ' ')
    expect(useUi.getState().playhead).toBe(0)
    press('Space', ' ')
  })

  it('ignores keys typed into inputs', () => {
    const input = document.createElement('input')
    document.body.appendChild(input)
    const e = new KeyboardEvent('keydown', { code: 'KeyK', key: 'k', ctrlKey: true, bubbles: true })
    Object.defineProperty(e, 'target', { value: input })
    expect(handleHotkey(e)).toBe(false)
    input.remove()
  })
})
