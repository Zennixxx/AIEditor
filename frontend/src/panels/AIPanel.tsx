import { useEffect, useRef, useState } from 'react'
import { findClip } from '@/model/lookup'
import { formatTimecode } from '@/shared/time'
import { useAi, type AiPreview, type ChatMessage } from '@/store/ai'
import { useBackend } from '@/store/backend'
import { useProject } from '@/store/project'
import { useUi } from '@/store/ui'
import styles from './AIPanel.module.css'
import { Panel } from './Panel'

const QUICK_PROMPTS = [
  'Шейк на сильные басы в дропе',
  'Velocity в конце',
  'Фликер на каждый 4-й бит',
  'Нарезать клипы по битам',
] as const

/** ИИ-ассистент: команды копилоту, предпросмотр ops («Применить» / «Отклонить»), запуск автоэдита. */
export function AIPanel() {
  const messages = useAi((s) => s.messages)
  const busy = useAi((s) => s.busy)
  const preview = useAi((s) => s.preview)
  const autoAnalyze = useAi((s) => s.autoAnalyze)
  const gemini = useBackend((s) => s.health?.gemini)
  const [text, setText] = useState('')
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages.length, preview])

  const send = (value: string) => {
    if (!value.trim() || busy) return
    void useAi.getState().send(value)
    setText('')
  }

  return (
    <Panel
      title="ИИ-ассистент"
      actions={
        <button
          className={styles.headerButton}
          onClick={() => useAi.getState().setWizardOpen(true)}
          data-testid="open-auto-edit"
          title="Собрать эдит из клипов под трек"
        >
          Автоэдит…
        </button>
      }
    >
      <div className={styles.ai} data-testid="ai-panel">
        {gemini === false && (
          <div className={styles.notice}>Ключ Gemini не задан на бэке — работает только автоэдит без ИИ.</div>
        )}
        <div ref={listRef} className={styles.messages} data-testid="ai-messages">
          {messages.length === 0 && !preview && (
            <div className={styles.placeholder}>
              Опишите, что сделать: «шейк на каждый сильный бас в дропе», «замедли последний клип»…
            </div>
          )}
          {messages.map((m) => (
            <Message key={m.id} message={m} />
          ))}
          {busy && <div className={styles.thinking}>Думаю…</div>}
          {preview && <PreviewCard preview={preview} />}
        </div>
        <div className={styles.chips}>
          {QUICK_PROMPTS.map((q) => (
            <button key={q} className={styles.chip} disabled={busy} onClick={() => send(q)}>
              {q}
            </button>
          ))}
        </div>
        <Context />
        <form
          className={styles.input}
          onSubmit={(e) => {
            e.preventDefault()
            send(text)
          }}
        >
          <textarea
            value={text}
            rows={2}
            placeholder="Команда для ИИ (Enter — отправить, Shift+Enter — новая строка)"
            onChange={(e) => setText(e.currentTarget.value)}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                send(text)
              }
            }}
            data-testid="ai-input"
          />
          <button type="submit" className={styles.send} disabled={busy || !text.trim()} data-testid="ai-send">
            ➤
          </button>
        </form>
        <label className={styles.setting}>
          <input
            type="checkbox"
            checked={autoAnalyze}
            onChange={(e) => useAi.getState().setAutoAnalyze(e.currentTarget.checked)}
          />
          ИИ-анализ видео при импорте
        </label>
      </div>
    </Panel>
  )
}

function Message({ message: m }: { message: ChatMessage }) {
  return (
    <div
      className={styles.message}
      data-role={m.role}
      data-error={m.error || undefined}
      data-testid="ai-message"
      data-status={m.status}
    >
      <div>{m.text}</div>
      {m.warnings?.map((w, i) => (
        <div key={i} className={styles.warning}>
          {w}
        </div>
      ))}
      {m.status === 'applied' && <div className={styles.status}>✓ Применено</div>}
      {m.status === 'rejected' && <div className={styles.status}>Отклонено</div>}
    </div>
  )
}

const MAX_LINES = 12

function PreviewCard({ preview: p }: { preview: AiPreview }) {
  const [expanded, setExpanded] = useState(false)
  const lines = expanded ? p.lines : p.lines.slice(0, MAX_LINES)
  return (
    <div className={styles.preview} data-testid="ai-preview">
      <div className={styles.previewTitle}>Предпросмотр: {p.label}</div>
      {p.messageId === null && p.explanation && <div>{p.explanation}</div>}
      <ul className={styles.lines}>
        {lines.map((l, i) => (
          <li key={i}>{l}</li>
        ))}
      </ul>
      {p.lines.length > MAX_LINES && (
        <button className={styles.more} onClick={() => setExpanded(!expanded)}>
          {expanded ? 'Свернуть' : `Ещё ${p.lines.length - MAX_LINES}`}
        </button>
      )}
      {p.messageId === null &&
        p.warnings.map((w, i) => (
          <div key={i} className={styles.warning}>
            {w}
          </div>
        ))}
      {p.error ? (
        <div className={styles.error} data-testid="ai-preview-error">
          Не применяется к проекту: {p.error}
        </div>
      ) : (
        <div className={styles.hint}>
          На таймлайне: пунктир — новое, фиолетовый контур — изменённое. Правка заблокирована до решения.
        </div>
      )}
      <div className={styles.previewActions}>
        <button onClick={() => useAi.getState().reject()} data-testid="ai-reject">
          Отклонить
        </button>
        <button
          className={styles.primary}
          disabled={!!p.error}
          onClick={() => useAi.getState().apply()}
          data-testid="ai-apply"
        >
          Применить
        </button>
      </div>
    </div>
  )
}

function Context() {
  const selection = useUi((s) => s.selection)
  const playhead = useUi((s) => s.playhead)
  const project = useProject((s) => s.project)
  const clips = selection.filter((id) => findClip(project, id)).length
  return (
    <div className={styles.context}>
      {clips > 0 ? `Выделено клипов: ${clips}` : 'Ничего не выделено'} · плейхед{' '}
      {formatTimecode(playhead, project.fps)}
    </div>
  )
}
