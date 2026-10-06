import { useState } from 'react'
import { IS_MOCK } from '@/api/config'
import { useProject } from '@/store/project'
import {
  openProject,
  renameProject,
  resolveConflictOverwrite,
  resolveConflictReload,
  saveNow,
  useSave,
  type SaveStatus,
} from '@/store/projectIo'
import { useUi } from '@/store/ui'
import { openExportDialog } from './actions'
import { BackendStatus } from './BackendStatus'
import { formatBinding, bindingsOf } from './keymap'
import styles from './TopBar.module.css'

/** Проект из shared/fixtures/project.json (есть в MSW-моках). */
const DEMO_PROJECT_ID = 'prj_demo000001'

const STATUS_TEXT: Record<SaveStatus, string> = {
  new: 'Новый',
  saved: 'Сохранено',
  dirty: 'Изменён',
  saving: 'Сохранение…',
  error: 'Не сохранено',
  conflict: 'Конфликт версий',
}

function hint(id: string): string {
  const b = bindingsOf(id)[0]
  return b ? ` (${formatBinding(b)})` : ''
}

function ProjectName() {
  const name = useProject((s) => s.project.name)
  return <NameInput key={name} name={name} />
}

function NameInput({ name }: { name: string }) {
  const [draft, setDraft] = useState(name)
  return (
    <input
      className={styles.name}
      value={draft}
      size={Math.max(8, Math.min(40, draft.length + 1))}
      onChange={(e) => setDraft(e.currentTarget.value)}
      onBlur={() => {
        renameProject(draft)
        if (!draft.trim()) setDraft(name)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
        if (e.key === 'Escape') {
          setDraft(name)
          requestAnimationFrame(() => (document.activeElement as HTMLElement | null)?.blur())
        }
      }}
      title="Название проекта"
      aria-label="Название проекта"
      data-testid="project-name"
    />
  )
}

function SaveIndicator() {
  const status = useSave((s) => s.status)
  const error = useSave((s) => s.error)
  const savedAt = useSave((s) => s.savedAt)
  const title =
    status === 'saved' && savedAt
      ? `Сохранено в ${new Date(savedAt).toLocaleTimeString('ru-RU')}`
      : status === 'error'
        ? `${error ?? 'Ошибка'} — повтор через несколько секунд`
        : status === 'new'
          ? 'Проект сохранится после первого изменения'
          : STATUS_TEXT[status]
  return (
    <span className={styles.saveWrap}>
      <button
        className={styles.save}
        data-status={status}
        onClick={() => void saveNow()}
        title={`${title}${hint('save')}`}
        data-testid="save-status"
      >
        {STATUS_TEXT[status]}
      </button>
      {status === 'conflict' && (
        <span className={styles.conflict} data-testid="save-conflict">
          Проект изменён в другом окне
          <button onClick={() => void resolveConflictReload()} data-testid="conflict-reload">
            Перезагрузить
          </button>
          <button onClick={() => void resolveConflictOverwrite()} data-testid="conflict-overwrite">
            Перезаписать
          </button>
        </span>
      )}
    </span>
  )
}

export function TopBar() {
  const error = useProject((s) => s.lastError)
  const setModal = useUi((s) => s.setModal)

  return (
    <header className={styles.bar}>
      <div className={styles.brand}>
        <span className={styles.logo} aria-hidden>
          ◆
        </span>
        AIEditor
      </div>
      <div className={styles.project}>
        <button
          className={styles.tool}
          onClick={() => setModal('projects')}
          title={`Проекты: новый, открыть, удалить${hint('projects')}`}
          data-testid="open-projects"
        >
          Проекты
        </button>
        <ProjectName />
        <SaveIndicator />
        {IS_MOCK && (
          <button
            className={styles.tool}
            onClick={() => void openProject(DEMO_PROJECT_ID)}
            title="Открыть проект из shared/fixtures"
          >
            Демо-проект
          </button>
        )}
        {error && (
          <span className={styles.error} title={error}>
            {error}
          </span>
        )}
      </div>
      <button
        className={styles.icon}
        onClick={() => setModal('hotkeys')}
        title={`Горячие клавиши${hint('hotkeys')}`}
        aria-label="Горячие клавиши"
        data-testid="open-hotkeys"
      >
        ?
      </button>
      <button
        className={styles.icon}
        onClick={() => setModal('settings')}
        title={`Настройки${hint('settings')}`}
        aria-label="Настройки"
        data-testid="open-settings"
      >
        ⚙
      </button>
      <button
        className={styles.export}
        onClick={openExportDialog}
        title="Экспорт видео и скрипта After Effects (I / O — диапазон на таймлайне)"
        data-testid="open-export"
      >
        Экспорт
      </button>
      <BackendStatus />
    </header>
  )
}
