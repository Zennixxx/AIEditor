import { useEffect, useState } from 'react'
import { cacheApi } from '@/api/cache'
import type { CacheCleanupResult } from '@/shared/types.gen'
import { useAi } from '@/store/ai'
import { useAssets } from '@/store/assets'
import { useBackend } from '@/store/backend'
import { saveNow } from '@/store/projectIo'
import { PREVIEW_QUALITIES, useSettings } from '@/store/settings'
import { useUi } from '@/store/ui'
import styles from './Dialog.module.css'
import { Modal } from './Modal'

function formatBytes(n: number): string {
  const units = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ']
  let v = n
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`
}

export function SettingsDialog() {
  const close = () => useUi.getState().setModal(null)
  const autoAnalyze = useAi((s) => s.autoAnalyze)
  const quality = useSettings((s) => s.previewQuality)
  const health = useBackend((s) => s.health)
  const [days, setDays] = useState(30)
  const [cleaning, setCleaning] = useState(false)
  const [result, setResult] = useState<CacheCleanupResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void useBackend.getState().refresh()
  }, [])

  const clean = async () => {
    setCleaning(true)
    setError(null)
    setResult(null)
    try {
      await saveNow()
      const res = await cacheApi.clean(days)
      useAssets.getState().removeAssets(res.removedAssets)
      setResult(res)
      void useBackend.getState().refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка очистки')
    } finally {
      setCleaning(false)
    }
  }

  const disk = health?.disk
  const used = disk && disk.total > 0 ? 1 - disk.free / disk.total : 0

  return (
    <Modal title="Настройки" testId="settings-dialog" onClose={close}>
      <section className={styles.section}>
        <h3>Превью</h3>
        <div className={styles.row}>
          <span className={styles.grow}>Качество (разрешение буфера; на экспорт не влияет)</span>
          {PREVIEW_QUALITIES.map((q) => (
            <button
              key={q.value}
              aria-pressed={quality === q.value}
              onClick={() => useSettings.getState().setPreviewQuality(q.value)}
              data-testid={`quality-${q.value}`}
            >
              {q.label}
            </button>
          ))}
        </div>
      </section>

      <section className={styles.section}>
        <h3>ИИ</h3>
        <div className={styles.row}>
          <label>
            <input
              type="checkbox"
              checked={autoAnalyze}
              onChange={(e) => useAi.getState().setAutoAnalyze(e.currentTarget.checked)}
              data-testid="settings-auto-analyze"
            />
            ИИ-анализ видео при импорте
          </label>
        </div>
        <div className={styles.hint}>
          {health?.gemini
            ? 'Ключ Gemini задан на бэке.'
            : 'Ключ Gemini не задан: GEMINI_API_KEY в backend/.env, затем перезапуск бэка.'}
        </div>
      </section>

      <section className={styles.section}>
        <h3>Бэк</h3>
        {!health && <div className={styles.error}>Бэк недоступен</div>}
        {health && (
          <>
            <div className={styles.row} data-testid="settings-gpu">
              <span className={styles.grow}>GPU для RIFE (Vulkan)</span>
              {!health.rife && (
                <span className={styles.warn}>RIFE не найден — интерполяция через ffmpeg</span>
              )}
              {health.rife && !health.gpus && <span className={styles.hint}>проверяется…</span>}
              {health.rife && health.gpus?.length === 0 && (
                <span className={styles.warn}>Vulkan-GPU нет — интерполяция через ffmpeg</span>
              )}
              {health.rife && health.gpus && health.gpus.length > 0 && (
                <span className={styles.ok}>{health.gpus.join(', ')}</span>
              )}
            </div>
            <div className={styles.row} data-testid="settings-disk">
              <span className={styles.grow}>
                Диск данных <span className={`${styles.dim} ${styles.mono}`}>{health.disk.path}</span>
              </span>
              <span className={used > 0.9 ? styles.warn : undefined}>
                свободно {formatBytes(health.disk.free)} из {formatBytes(health.disk.total)}
              </span>
            </div>
            <div className={styles.meter}>
              <span style={{ width: `${Math.round(used * 100)}%` }} />
            </div>
          </>
        )}
      </section>

      <section className={styles.section}>
        <h3>Кэш</h3>
        <div className={styles.hint}>
          Удаляет ассеты, которые не используются ни в одном сохранённом проекте и не менялись заданное число
          дней (прокси, интерполяции, превью-кадры, анализы, загруженные копии), и старые ответы Gemini.
          Оригиналы на диске не трогаются.
        </div>
        <div className={styles.row}>
          <label>
            старше
            <input
              type="number"
              min={0}
              step={1}
              value={days}
              onChange={(e) => setDays(Math.max(0, Math.floor(Number(e.currentTarget.value) || 0)))}
              aria-label="Старше, дней"
              data-testid="cache-days"
            />
            дн.
          </label>
          <button disabled={cleaning || !health} onClick={() => void clean()} data-testid="cache-clean">
            {cleaning ? 'Очистка…' : 'Очистить'}
          </button>
          {result && (
            <span className={styles.ok} data-testid="cache-result">
              удалено ассетов: {result.removedAssets.length}, ответов Gemini: {result.geminiFiles},
              освобождено {formatBytes(result.freedBytes)}
            </span>
          )}
          {error && <span className={styles.error}>{error}</span>}
        </div>
      </section>
    </Modal>
  )
}
