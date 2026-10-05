import { useEffect, useRef } from 'react'
import { findMarker } from '@/model/lookup'
import { MARKER_COLORS, markerColor } from '@/model/markers'
import { formatTimecode } from '@/shared/time'
import { useProject } from '@/store/project'
import { useUi } from '@/store/ui'
import styles from './Inspector.module.css'

/** Редактирование label и цвета выбранного маркера (двойной клик по маркеру фокусирует поле label). */
export function MarkerEditor({ markerId }: { markerId: string }) {
  const marker = useProject((s) => findMarker(s.project, markerId)?.marker)
  const fps = useProject((s) => s.project.fps)
  const focusId = useUi((s) => s.focusMarkerId)
  const labelRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (focusId === markerId) {
      labelRef.current?.focus()
      labelRef.current?.select()
      useUi.getState().focusMarker(null)
    }
  }, [focusId, markerId])

  if (!marker) return null
  // непрерывный ввод/выбор цвета склеивается в одну запись истории
  const update = (patch: { label?: string; color?: string }, key: string) =>
    useProject.getState().dispatch([{ op: 'updateMarker', markerId, patch }], {
      label: 'Правка маркера',
      mergeKey: `marker-edit:${markerId}:${key}`,
    })
  const seal = () => useProject.getState().sealHistory()

  return (
    <section className={styles.section} data-testid="marker-editor" aria-label="Маркер">
      <h3 className={styles.heading}>Маркер</h3>
      <div className={styles.meta}>
        {marker.kind} · сила {Math.round(marker.strength * 100)}% · {formatTimecode(marker.t, fps)}
      </div>
      <label className={styles.row}>
        <span>Подпись</span>
        <input
          ref={labelRef}
          type="text"
          value={marker.label ?? ''}
          placeholder="без подписи"
          onChange={(e) => update({ label: e.currentTarget.value }, 'label')}
          onBlur={seal}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === 'Escape') e.currentTarget.blur()
          }}
          data-testid="marker-label-input"
        />
      </label>
      <label className={styles.row}>
        <span>Цвет</span>
        <span className={styles.colorRow}>
          <input
            type="color"
            value={markerColor(marker).slice(0, 7)}
            onChange={(e) => update({ color: e.currentTarget.value }, 'color')}
            onBlur={seal}
            data-testid="marker-color-input"
          />
          <button
            type="button"
            className={styles.small}
            onClick={() => {
              update({ color: MARKER_COLORS[marker.kind] }, 'color-reset')
              seal()
            }}
          >
            По виду
          </button>
        </span>
      </label>
    </section>
  )
}
