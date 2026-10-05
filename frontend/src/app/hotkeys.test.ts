import { beforeEach, describe, expect, it } from 'vitest'
import { allClips, findClip } from '@/model/lookup'
import { DEFAULT_VISIBILITY } from '@/model/markers'
import { musicProject, sampleProject } from '@/model/testUtils'
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

describe('marker hotkeys', () => {
  beforeEach(() => {
    const p = musicProject() // музыка: start 10, source 20..50
    useProject.getState().load(p)
    useProject.getState().dispatch([
      {
        op: 'addMarkers',
        target: { clipId: 'clp_music' },
        markers: [
          { id: 'mrk_a', t: 22, kind: 'bass', strength: 0.9 }, // timeline 12
          { id: 'mrk_on', t: 24, kind: 'onset', strength: 1 }, // 14, скрыт по умолчанию
          { id: 'mrk_weak', t: 26, kind: 'bass', strength: 0.1 }, // 16
          { id: 'mrk_b', t: 28, kind: 'bass', strength: 0.8 }, // 18
        ],
      },
    ])
    useUi.setState({
      selection: [],
      markerSelection: [],
      markerVisibility: DEFAULT_VISIBILITY,
      playhead: 0,
      tool: 'select',
    })
  })

  const markers = () => findClip(useProject.getState().project, 'clp_music')!.clip.markers
  const projectMarkers = () => useProject.getState().project.markers

  it('M adds a project marker, or a clip marker when an audio clip under the playhead is selected', () => {
    useUi.setState({ playhead: 5 })
    expect(press('KeyM', 'm')).toBe(true)
    expect(projectMarkers().map((m) => [m.t, m.kind])).toEqual([[5, 'manual']])
    expect(useUi.getState().markerSelection).toHaveLength(1)

    useUi.setState({ playhead: 15, selection: ['clp_music'] })
    press('KeyM', 'ь') // русская раскладка
    const added = markers().find((m) => m.kind === 'manual')!
    expect(added.t).toBeCloseTo(25, 9) // 20 + (15 − 10)
    // повтор клавиши (удержание) маркеры не плодит
    press('KeyM', 'm', { repeat: true })
    expect(markers().filter((m) => m.kind === 'manual')).toHaveLength(1)
    // одна запись истории на маркер
    press('KeyZ', 'z', { ctrlKey: true })
    expect(markers().filter((m) => m.kind === 'manual')).toHaveLength(0)
  })

  it('Shift+→ / Shift+← jump between visible markers (hidden onset and below-threshold are skipped)', () => {
    useUi.setState({ playhead: 0 })
    press('ArrowRight', 'ArrowRight', { shiftKey: true })
    expect(useUi.getState().playhead).toBeCloseTo(12)
    press('ArrowRight', 'ArrowRight', { shiftKey: true })
    expect(useUi.getState().playhead).toBeCloseTo(16) // onset (14) скрыт
    useUi.getState().setMarkerVisibility({ minStrength: 0.5 })
    useUi.setState({ playhead: 12 })
    press('ArrowRight', 'ArrowRight', { shiftKey: true })
    expect(useUi.getState().playhead).toBeCloseTo(18) // mrk_weak (16) скрыт порогом
    press('ArrowLeft', 'ArrowLeft', { shiftKey: true })
    expect(useUi.getState().playhead).toBeCloseTo(12)
    press('ArrowLeft', 'ArrowLeft', { shiftKey: true })
    expect(useUi.getState().playhead).toBeCloseTo(12) // левее маркеров нет
    useUi.getState().setMarkerVisibility({ kinds: [...DEFAULT_VISIBILITY.kinds, 'onset'] })
    useUi.setState({ playhead: 12 })
    press('ArrowRight', 'ArrowRight', { shiftKey: true })
    expect(useUi.getState().playhead).toBeCloseTo(14)
  })

  it('Delete removes selected markers (not clips); Ctrl+Z restores them; Escape clears the marker selection', () => {
    useUi.setState({ selection: ['clp_music'], markerSelection: ['mrk_a', 'mrk_b'] })
    press('Delete', 'Delete')
    expect(markers().map((m) => m.id)).toEqual(['mrk_on', 'mrk_weak'])
    expect(findClip(useProject.getState().project, 'clp_music')).toBeTruthy()
    expect(useUi.getState().markerSelection).toEqual([])
    press('KeyZ', 'z', { ctrlKey: true })
    expect(markers()).toHaveLength(4)
    // без выделенных маркеров Delete удаляет клип
    press('Delete', 'Delete')
    expect(findClip(useProject.getState().project, 'clp_music')).toBeUndefined()
    useUi.setState({ markerSelection: ['mrk_x'] })
    press('Escape', 'Escape')
    expect(useUi.getState().markerSelection).toEqual([])
  })
})
