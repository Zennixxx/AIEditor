import { IS_MOCK } from '@/api/config'
import { useProject } from '@/store/project'
import { openProject } from '@/store/projectIo'
import { openExportDialog } from './actions'
import { BackendStatus } from './BackendStatus'
import styles from './TopBar.module.css'

/** Проект из shared/fixtures/project.json (есть в MSW-моках). */
const DEMO_PROJECT_ID = 'prj_demo000001'

export function TopBar() {
  const name = useProject((s) => s.project.name)
  const error = useProject((s) => s.lastError)

  return (
    <header className={styles.bar}>
      <div className={styles.brand}>
        <span className={styles.logo} aria-hidden>
          ◆
        </span>
        AIEditor
      </div>
      <div className={styles.project}>
        <span data-testid="project-name">{name}</span>
        {IS_MOCK && (
          <button
            className={styles.demo}
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
