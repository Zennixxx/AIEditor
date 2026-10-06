import { useEffect, useState } from 'react'
import { ApiError } from '@/api/client'
import { useProject } from '@/store/project'
import {
  deleteProject,
  newProject,
  openProject,
  refreshProjects,
  useSave,
  type RecentProject,
} from '@/store/projectIo'
import { useUi } from '@/store/ui'
import styles from './Dialog.module.css'
import { Modal } from './Modal'

const FPS = [24, 25, 30, 50, 60] as const
const SIZES = [
  { label: '1920×1080 (16:9)', width: 1920, height: 1080 },
  { label: '1080×1920 (9:16, вертикальное)', width: 1080, height: 1920 },
  { label: '1080×1080 (1:1)', width: 1080, height: 1080 },
  { label: '1280×720 (16:9)', width: 1280, height: 720 },
  { label: '3840×2160 (4K)', width: 3840, height: 2160 },
]
const RECENT_SHOWN = 5

function when(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function errorText(e: unknown): string {
  return e instanceof ApiError || e instanceof Error ? e.message : 'Ошибка'
}

export function ProjectsDialog() {
  const close = () => useUi.getState().setModal(null)
  const currentId = useProject((s) => s.project.id)
  const projects = useSave((s) => s.projects)
  const recent = useSave((s) => s.recent)
  const listError = useSave((s) => s.projectsError)
  const [name, setName] = useState('Без названия')
  const [fps, setFps] = useState<(typeof FPS)[number]>(30)
  const [size, setSize] = useState(0)
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void refreshProjects()
  }, [])

  const run = async (fn: () => Promise<void>, closeAfter = true) => {
    setBusy(true)
    setError(null)
    try {
      await fn()
      if (closeAfter) close()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  const known = new Set(projects.map((p) => p.id))
  const recentShown: RecentProject[] = recent
    .filter((r) => listError !== null || known.has(r.id))
    .slice(0, RECENT_SHOWN)

  const row = (id: string, title: string, date: string, testPrefix: string) => (
    <div
      key={`${testPrefix}-${id}`}
      className={styles.item}
      aria-current={id === currentId}
      data-testid={`${testPrefix}-${id}`}
    >
      <span className={styles.name} title={title}>
        {title}
      </span>
      <span className={styles.dim}>{when(date)}</span>
      <button disabled={busy || id === currentId} onClick={() => void run(() => openProject(id))}>
        {id === currentId ? 'Открыт' : 'Открыть'}
      </button>
      {confirmId === id ? (
        <button
          className={styles.danger}
          disabled={busy}
          onClick={() =>
            void run(async () => {
              await deleteProject(id)
              setConfirmId(null)
            }, false)
          }
          data-testid={`confirm-delete-${id}`}
        >
          Точно удалить?
        </button>
      ) : (
        <button disabled={busy} onClick={() => setConfirmId(id)} title="Удалить проект и его историю версий">
          Удалить
        </button>
      )}
    </div>
  )

  return (
    <Modal title="Проекты" testId="projects-dialog" wide onClose={close}>
      <section className={styles.section}>
        <h3>Новый проект</h3>
        <div className={styles.row}>
          <input
            type="text"
            className={styles.grow}
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
            aria-label="Название проекта"
            data-testid="new-project-name"
          />
          <select
            value={fps}
            onChange={(e) => setFps(Number(e.currentTarget.value) as (typeof FPS)[number])}
            aria-label="Кадров в секунду"
          >
            {FPS.map((f) => (
              <option key={f} value={f}>
                {f} fps
              </option>
            ))}
          </select>
          <select
            value={size}
            onChange={(e) => setSize(Number(e.currentTarget.value))}
            aria-label="Размер кадра"
          >
            {SIZES.map((s, i) => (
              <option key={s.label} value={i}>
                {s.label}
              </option>
            ))}
          </select>
          <button
            className={styles.primary}
            disabled={busy}
            onClick={() =>
              void run(() =>
                newProject({
                  name: name.trim() || 'Без названия',
                  fps,
                  width: SIZES[size]!.width,
                  height: SIZES[size]!.height,
                }),
              )
            }
            data-testid="create-project"
          >
            Создать
          </button>
        </div>
        <div className={styles.hint}>Новый проект сохраняется на бэке после первого изменения.</div>
      </section>

      {recentShown.length > 0 && (
        <section className={styles.section}>
          <h3>Недавние</h3>
          <div className={styles.list}>{recentShown.map((r) => row(r.id, r.name, r.openedAt, 'recent'))}</div>
        </section>
      )}

      <section className={styles.section}>
        <h3>Все проекты</h3>
        {listError && <div className={styles.error}>{listError}</div>}
        {!listError && projects.length === 0 && (
          <div className={styles.hint}>Сохранённых проектов пока нет</div>
        )}
        <div className={styles.list}>{projects.map((p) => row(p.id, p.name, p.updatedAt, 'project'))}</div>
      </section>
      {error && <div className={styles.error}>{error}</div>}
    </Modal>
  )
}
