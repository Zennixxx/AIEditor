import { IS_MOCK } from '@/api/config'
import { useBackend } from '@/store/backend'
import styles from './BackendStatus.module.css'

type Level = 'ok' | 'warn' | 'err'

const CAPABILITIES = [
  { key: 'ffmpeg', label: 'ffmpeg', hint: 'Импорт, прокси, превью-кадры' },
  { key: 'rife', label: 'RIFE', hint: 'Интерполяция кадров для замедления' },
  { key: 'demucs', label: 'Demucs', hint: 'Разделение трека на дорожки (опционально)' },
  { key: 'gemini', label: 'Gemini', hint: 'ИИ-функции: задайте GEMINI_API_KEY в backend/.env' },
] as const

/** Индикатор состояния бэка: /health + WS. */
export function BackendStatus() {
  const { health, error, ws, serverVersion } = useBackend()

  let level: Level = 'err'
  let text = 'Бэкенд недоступен'
  if (health) {
    level = ws === 'open' ? 'ok' : 'warn'
    text = ws === 'open' ? 'Бэкенд подключён' : 'Нет WS-событий'
  } else if (!error) {
    level = 'warn'
    text = 'Проверка…'
  }

  const title = [
    text,
    error ? `Ошибка: ${error}` : null,
    health ? `Версия ${serverVersion ?? health.version}, схема v${health.schemaVersion}` : null,
    `WebSocket: ${ws}`,
  ]
    .filter(Boolean)
    .join('\n')

  return (
    <div className={styles.status} data-testid="backend-status" data-level={level}>
      {IS_MOCK && <span className={styles.mock}>MOCK</span>}
      {health &&
        CAPABILITIES.map((c) => (
          <span
            key={c.key}
            className={styles.chip}
            data-on={health[c.key]}
            title={`${c.hint}: ${health[c.key] ? 'доступно' : 'недоступно'}`}
          >
            {c.label}
          </span>
        ))}
      <span className={styles.main} title={title}>
        <span className={styles.dot} aria-hidden />
        {text}
      </span>
    </div>
  )
}
