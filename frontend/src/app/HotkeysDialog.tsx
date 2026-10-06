import { useEffect, useState } from 'react'
import { useUi } from '@/store/ui'
import styles from './Dialog.module.css'
import { bindingFromEvent, bindingsOf, COMMAND_GROUPS, COMMANDS, formatBinding, useKeymap } from './keymap'
import { Modal } from './Modal'

const MOUSE_TIPS: [string, string][] = [
  ['Колесо', 'прокрутка по времени'],
  ['Shift + колесо', 'прокрутка дорожек'],
  ['Ctrl + колесо', 'зум таймлайна'],
  ['Shift при перетаскивании', 'без привязки'],
  ['Alt + рамка', 'выделение маркеров'],
  ['Alt + перетаскивание клипа', 'вставка со сдвигом (ripple)'],
]

export function HotkeysDialog() {
  const close = () => useUi.getState().setModal(null)
  const overrides = useKeymap((s) => s.overrides)
  const [capture, setCapture] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [filter, setFilter] = useState('')

  useEffect(() => {
    if (!capture) return
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (e.code === 'Escape' && !e.ctrlKey && !e.shiftKey && !e.altKey) {
        setCapture(null)
        return
      }
      const b = bindingFromEvent(e)
      if (!b) return
      const taken = useKeymap.getState().assign(capture, b)
      const names = taken.map((id) => COMMANDS.find((c) => c.id === id)?.label ?? id)
      setNotice(names.length ? `${formatBinding(b)} снята с: ${names.join(', ')}` : null)
      setCapture(null)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [capture])

  const q = filter.trim().toLowerCase()
  const visible = COMMANDS.filter(
    (c) =>
      !q ||
      c.label.toLowerCase().includes(q) ||
      bindingsOf(c.id, overrides).some((b) => formatBinding(b).toLowerCase().includes(q)),
  )

  return (
    <Modal
      title="Горячие клавиши"
      testId="hotkeys-dialog"
      wide
      onClose={close}
      captureEscape={capture !== null}
    >
      <div className={styles.row}>
        <input
          type="text"
          className={styles.grow}
          placeholder="Поиск команды или клавиши"
          value={filter}
          onChange={(e) => setFilter(e.currentTarget.value)}
          aria-label="Поиск"
        />
        <button
          onClick={() => {
            useKeymap.getState().resetAll()
            setNotice(null)
          }}
          disabled={Object.keys(overrides).length === 0}
          data-testid="hotkeys-reset-all"
        >
          Сбросить все
        </button>
      </div>
      {notice && <div className={styles.warn}>{notice}</div>}
      {COMMAND_GROUPS.map((group) => {
        const list = visible.filter((c) => c.group === group)
        if (list.length === 0) return null
        return (
          <section key={group} className={styles.section}>
            <h3>{group}</h3>
            {list.map((c) => {
              const bindings = bindingsOf(c.id, overrides)
              const custom = c.id in overrides
              return (
                <div key={c.id} className={styles.item} data-testid={`hotkey-${c.id}`}>
                  <span className={styles.name}>{c.label}</span>
                  <span className={styles.chips}>
                    {capture === c.id ? (
                      <span className={`${styles.key} ${styles.capture}`}>
                        нажмите клавишу… (Esc — отмена)
                      </span>
                    ) : bindings.length === 0 ? (
                      <span className={styles.dim}>не назначена</span>
                    ) : (
                      bindings.map((b) => (
                        <kbd key={formatBinding(b)} className={styles.key}>
                          {formatBinding(b)}
                        </kbd>
                      ))
                    )}
                  </span>
                  <button
                    aria-pressed={capture === c.id}
                    onClick={() => setCapture(capture === c.id ? null : c.id)}
                    data-testid={`rebind-${c.id}`}
                  >
                    Изменить
                  </button>
                  <button
                    disabled={!custom}
                    onClick={() => useKeymap.getState().reset(c.id)}
                    title="Вернуть клавиши по умолчанию"
                  >
                    Сброс
                  </button>
                </div>
              )
            })}
          </section>
        )
      })}
      {!q && (
        <section className={styles.section}>
          <h3>Мышь</h3>
          {MOUSE_TIPS.map(([k, v]) => (
            <div key={k} className={styles.item}>
              <span className={styles.name}>{v}</span>
              <kbd className={styles.key}>{k}</kbd>
            </div>
          ))}
        </section>
      )}
    </Modal>
  )
}
