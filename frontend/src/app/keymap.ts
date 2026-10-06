// Раскладка горячих клавиш: команды, клавиши по умолчанию, пользовательские переназначения (localStorage).
// Клавиши сравниваются по e.code — работают в любой раскладке (Ctrl+K в русской = Ctrl+Л).
import { create } from 'zustand'

export interface Binding {
  code: string
  ctrl?: boolean
  shift?: boolean
  alt?: boolean
}

export type CommandGroup = 'Правка' | 'Транспорт' | 'Маркеры' | 'Таймлайн' | 'Окна'

export interface CommandDef {
  id: string
  label: string
  group: CommandGroup
  defaults: Binding[]
  /** Удержание клавиши (автоповтор) не повторяет команду. */
  noRepeat?: boolean
}

export const COMMANDS: readonly CommandDef[] = [
  { id: 'undo', label: 'Отменить', group: 'Правка', defaults: [{ code: 'KeyZ', ctrl: true }] },
  {
    id: 'redo',
    label: 'Повторить',
    group: 'Правка',
    defaults: [
      { code: 'KeyZ', ctrl: true, shift: true },
      { code: 'KeyY', ctrl: true },
    ],
  },
  {
    id: 'split',
    label: 'Разрезать под плейхедом',
    group: 'Правка',
    defaults: [{ code: 'KeyK', ctrl: true }],
  },
  { id: 'selectAll', label: 'Выделить всё', group: 'Правка', defaults: [{ code: 'KeyA', ctrl: true }] },
  { id: 'copy', label: 'Копировать', group: 'Правка', defaults: [{ code: 'KeyC', ctrl: true }] },
  { id: 'paste', label: 'Вставить под плейхед', group: 'Правка', defaults: [{ code: 'KeyV', ctrl: true }] },
  {
    id: 'delete',
    label: 'Удалить выделенное',
    group: 'Правка',
    defaults: [{ code: 'Delete' }, { code: 'Backspace' }],
  },
  {
    id: 'rippleDelete',
    label: 'Удалить со сдвигом (ripple)',
    group: 'Правка',
    defaults: [
      { code: 'Delete', shift: true },
      { code: 'Backspace', shift: true },
    ],
  },
  {
    id: 'escape',
    label: 'Снять выделение, инструмент «Выбор»',
    group: 'Правка',
    defaults: [{ code: 'Escape' }],
  },
  { id: 'toolSelect', label: 'Инструмент «Выбор»', group: 'Правка', defaults: [{ code: 'KeyV' }] },
  { id: 'toolBlade', label: 'Инструмент «Лезвие»', group: 'Правка', defaults: [{ code: 'KeyC' }] },

  {
    id: 'playPause',
    label: 'Воспроизведение / пауза',
    group: 'Транспорт',
    defaults: [{ code: 'Space' }],
    noRepeat: true,
  },
  {
    id: 'shuttleBack',
    label: 'Назад (J, повтор — быстрее)',
    group: 'Транспорт',
    defaults: [{ code: 'KeyJ' }],
  },
  { id: 'stop', label: 'Стоп', group: 'Транспорт', defaults: [{ code: 'KeyK' }] },
  {
    id: 'shuttleForward',
    label: 'Вперёд (L, повтор — быстрее)',
    group: 'Транспорт',
    defaults: [{ code: 'KeyL' }],
  },
  { id: 'frameBack', label: 'Кадр назад', group: 'Транспорт', defaults: [{ code: 'ArrowLeft' }] },
  { id: 'frameForward', label: 'Кадр вперёд', group: 'Транспорт', defaults: [{ code: 'ArrowRight' }] },
  { id: 'home', label: 'В начало', group: 'Транспорт', defaults: [{ code: 'Home' }] },
  { id: 'end', label: 'В конец', group: 'Транспорт', defaults: [{ code: 'End' }] },
  { id: 'setIn', label: 'Точка входа (In)', group: 'Транспорт', defaults: [{ code: 'KeyI' }] },
  { id: 'setOut', label: 'Точка выхода (Out)', group: 'Транспорт', defaults: [{ code: 'KeyO' }] },
  {
    id: 'clearInOut',
    label: 'Сбросить In / Out',
    group: 'Транспорт',
    defaults: [{ code: 'KeyX', alt: true }],
  },

  {
    id: 'addMarker',
    label: 'Добавить маркер',
    group: 'Маркеры',
    defaults: [{ code: 'KeyM' }],
    noRepeat: true,
  },
  {
    id: 'prevMarker',
    label: 'К предыдущему маркеру',
    group: 'Маркеры',
    defaults: [{ code: 'ArrowLeft', shift: true }],
  },
  {
    id: 'nextMarker',
    label: 'К следующему маркеру',
    group: 'Маркеры',
    defaults: [{ code: 'ArrowRight', shift: true }],
  },

  { id: 'toggleSnap', label: 'Привязка вкл / выкл', group: 'Таймлайн', defaults: [{ code: 'KeyS' }] },
  {
    id: 'zoomIn',
    label: 'Приблизить',
    group: 'Таймлайн',
    defaults: [{ code: 'Equal' }, { code: 'Equal', shift: true }, { code: 'NumpadAdd' }],
  },
  {
    id: 'zoomOut',
    label: 'Отдалить',
    group: 'Таймлайн',
    defaults: [{ code: 'Minus' }, { code: 'Minus', shift: true }, { code: 'NumpadSubtract' }],
  },
  { id: 'zoomFit', label: 'Вписать проект', group: 'Таймлайн', defaults: [{ code: 'Backslash' }] },
  { id: 'lanePosition', label: 'Дорожка позиции', group: 'Таймлайн', defaults: [{ code: 'KeyP' }] },
  {
    id: 'laneScale',
    label: 'Дорожка масштаба',
    group: 'Таймлайн',
    defaults: [{ code: 'KeyS', shift: true }],
  },
  { id: 'laneRotation', label: 'Дорожка поворота', group: 'Таймлайн', defaults: [{ code: 'KeyR' }] },
  { id: 'laneOpacity', label: 'Дорожка непрозрачности', group: 'Таймлайн', defaults: [{ code: 'KeyT' }] },
  {
    id: 'lanesAnimated',
    label: 'Анимированные свойства / скрыть дорожки',
    group: 'Таймлайн',
    defaults: [{ code: 'KeyU' }],
  },
  {
    id: 'curveEditor',
    label: 'Граф-редактор скорости',
    group: 'Таймлайн',
    defaults: [{ code: 'F3', shift: true }],
  },

  {
    id: 'hotkeys',
    label: 'Горячие клавиши',
    group: 'Окна',
    defaults: [{ code: 'Slash', shift: true }, { code: 'F1' }],
  },
  { id: 'projects', label: 'Проекты', group: 'Окна', defaults: [{ code: 'KeyO', ctrl: true }] },
  { id: 'settings', label: 'Настройки', group: 'Окна', defaults: [{ code: 'Comma', ctrl: true }] },
  { id: 'save', label: 'Сохранить сейчас', group: 'Окна', defaults: [{ code: 'KeyS', ctrl: true }] },
  { id: 'export', label: 'Экспорт', group: 'Окна', defaults: [{ code: 'KeyE', ctrl: true }] },
]

export const COMMAND_GROUPS: readonly CommandGroup[] = ['Правка', 'Транспорт', 'Маркеры', 'Таймлайн', 'Окна']

const MODIFIER_CODES = new Set([
  'ShiftLeft',
  'ShiftRight',
  'ControlLeft',
  'ControlRight',
  'AltLeft',
  'AltRight',
  'MetaLeft',
  'MetaRight',
  'CapsLock',
])

export function bindingFromEvent(
  e: Pick<KeyboardEvent, 'code' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>,
): Binding | null {
  if (!e.code || MODIFIER_CODES.has(e.code)) return null
  const b: Binding = { code: e.code }
  if (e.ctrlKey || e.metaKey) b.ctrl = true
  if (e.shiftKey) b.shift = true
  if (e.altKey) b.alt = true
  return b
}

export function sameBinding(a: Binding, b: Binding): boolean {
  return a.code === b.code && !!a.ctrl === !!b.ctrl && !!a.shift === !!b.shift && !!a.alt === !!b.alt
}

const CODE_LABELS: Record<string, string> = {
  ArrowLeft: '←',
  ArrowRight: '→',
  ArrowUp: '↑',
  ArrowDown: '↓',
  Space: 'Space',
  Equal: '=',
  Minus: '−',
  Backslash: '\\',
  Slash: '/',
  Comma: ',',
  Period: '.',
  Semicolon: ';',
  Quote: "'",
  BracketLeft: '[',
  BracketRight: ']',
  Backquote: '`',
  NumpadAdd: 'Num +',
  NumpadSubtract: 'Num −',
  NumpadMultiply: 'Num *',
  NumpadDivide: 'Num /',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Escape: 'Esc',
  Enter: 'Enter',
  Tab: 'Tab',
}

export function codeLabel(code: string): string {
  if (CODE_LABELS[code]) return CODE_LABELS[code]
  if (/^Key[A-Z]$/.test(code)) return code.slice(3)
  if (/^Digit\d$/.test(code)) return code.slice(5)
  if (/^Numpad\d$/.test(code)) return `Num ${code.slice(6)}`
  return code
}

export function formatBinding(b: Binding): string {
  return [b.ctrl && 'Ctrl', b.alt && 'Alt', b.shift && 'Shift', codeLabel(b.code)].filter(Boolean).join('+')
}

const KEYMAP_KEY = 'aieditor.keymap'

type Overrides = Record<string, Binding[]>

function readOverrides(): Overrides {
  try {
    const raw = localStorage.getItem(KEYMAP_KEY)
    const data: unknown = raw ? JSON.parse(raw) : {}
    if (typeof data !== 'object' || data === null) return {}
    const out: Overrides = {}
    for (const [id, list] of Object.entries(data as Record<string, unknown>)) {
      if (!COMMANDS.some((c) => c.id === id) || !Array.isArray(list)) continue
      out[id] = list.filter((b): b is Binding => typeof (b as Binding)?.code === 'string')
    }
    return out
  } catch {
    return {}
  }
}

function writeOverrides(overrides: Overrides): void {
  try {
    localStorage.setItem(KEYMAP_KEY, JSON.stringify(overrides))
  } catch {
    // без localStorage переназначения живут до перезагрузки
  }
}

interface KeymapState {
  overrides: Overrides
  /** Назначить команде одну клавишу; у других команд эта клавиша снимается. Возвращает id таких команд. */
  assign: (id: string, binding: Binding) => string[]
  reset: (id: string) => void
  resetAll: () => void
}

export function bindingsOf(id: string, overrides: Overrides = useKeymap.getState().overrides): Binding[] {
  return overrides[id] ?? COMMANDS.find((c) => c.id === id)?.defaults ?? []
}

export function commandFor(
  b: Binding,
  overrides: Overrides = useKeymap.getState().overrides,
): CommandDef | null {
  return COMMANDS.find((c) => bindingsOf(c.id, overrides).some((x) => sameBinding(x, b))) ?? null
}

export const useKeymap = create<KeymapState>()((set, get) => ({
  overrides: readOverrides(),
  assign: (id, binding) => {
    const overrides = { ...get().overrides }
    const taken: string[] = []
    for (const c of COMMANDS) {
      if (c.id === id) continue
      const list = bindingsOf(c.id, overrides)
      if (!list.some((x) => sameBinding(x, binding))) continue
      overrides[c.id] = list.filter((x) => !sameBinding(x, binding))
      taken.push(c.id)
    }
    overrides[id] = [binding]
    set({ overrides })
    writeOverrides(overrides)
    return taken
  },
  reset: (id) => {
    const overrides = { ...get().overrides }
    delete overrides[id]
    set({ overrides })
    writeOverrides(overrides)
  },
  resetAll: () => {
    set({ overrides: {} })
    writeOverrides({})
  },
}))
