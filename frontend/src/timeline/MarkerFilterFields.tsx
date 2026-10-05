// Поля фильтра маркеров (CONTRACT §6, MarkerFilter) — общие для диалогов макро-ops
// («Нарезать по маркерам», «Эффект по маркерам»). Стили — CutDialog.module.css.
import { isClip } from '@/model/lookup'
import { MARKER_KINDS } from '@/model/markers'
import { SECTION_LABELS } from '@/model/sections'
import type { Project } from '@/shared/types.gen'
import { useAssets } from '@/store/assets'
import styles from './CutDialog.module.css'
import { toggle, type FilterForm } from './filterForm'

interface Props {
  project: Project
  value: FilterForm
  onChange: (patch: Partial<FilterForm>) => void
  /** Префикс data-testid: `${prefix}-kind-bass`, `${prefix}-strength`… */
  testPrefix: string
}

export function MarkerFilterFields({ project, value: f, onChange: patch, testPrefix: tp }: Props) {
  const assetName = (id: string) => useAssets.getState().assets[id]?.name ?? id
  const audioClips = project.tracks.flatMap((t) => (t.kind === 'audio' ? t.items.filter(isClip) : []))
  return (
    <>
      <label className={styles.row}>
        Музыка
        <select
          value={f.musicClipId}
          onChange={(e) => patch({ musicClipId: e.currentTarget.value })}
          data-testid={`${tp}-music`}
        >
          <option value="">Первый аудиоклип с маркерами</option>
          {audioClips.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label ?? assetName(c.assetId)}
            </option>
          ))}
        </select>
      </label>
      <div className={styles.chips}>
        {MARKER_KINDS.map((k) => (
          <button
            key={k}
            aria-pressed={f.kinds.includes(k)}
            onClick={() => patch({ kinds: toggle(f.kinds, k) })}
            data-testid={`${tp}-kind-${k}`}
          >
            {k}
          </button>
        ))}
      </div>
      <label className={styles.row}>
        Порог силы {Math.round(f.minStrength * 100)}%
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={f.minStrength}
          onChange={(e) => patch({ minStrength: Number(e.currentTarget.value) })}
          data-testid={`${tp}-strength`}
        />
      </label>
      <div className={styles.inline}>
        <label>
          Каждый
          <input
            type="number"
            min={1}
            step={1}
            value={f.every}
            onChange={(e) => patch({ every: Math.max(1, Math.round(Number(e.currentTarget.value) || 1)) })}
            data-testid={`${tp}-every`}
          />
          -й
        </label>
        <label>
          Смещение
          <input
            type="number"
            min={0}
            step={1}
            value={f.offset}
            onChange={(e) => patch({ offset: Math.max(0, Math.round(Number(e.currentTarget.value) || 0)) })}
            data-testid={`${tp}-offset`}
          />
        </label>
      </div>
      <div className={styles.chips} title="Секции музыки; ничего не выбрано — любые">
        {SECTION_LABELS.map((l) => (
          <button
            key={l}
            aria-pressed={f.sectionLabels.includes(l)}
            onClick={() => patch({ sectionLabels: toggle(f.sectionLabels, l) })}
            data-testid={`${tp}-section-${l}`}
          >
            {l}
          </button>
        ))}
      </div>
      <div className={styles.inline}>
        <label className={styles.check}>
          <input
            type="checkbox"
            checked={f.useRange}
            onChange={(e) => patch({ useRange: e.currentTarget.checked })}
            data-testid={`${tp}-range-on`}
          />
          Диапазон, с
        </label>
        <input
          type="number"
          min={0}
          step={0.5}
          disabled={!f.useRange}
          value={f.rangeStart}
          onChange={(e) => patch({ rangeStart: Number(e.currentTarget.value) || 0 })}
          data-testid={`${tp}-range-start`}
        />
        <span>—</span>
        <input
          type="number"
          min={0}
          step={0.5}
          disabled={!f.useRange}
          value={f.rangeEnd}
          onChange={(e) => patch({ rangeEnd: Number(e.currentTarget.value) || 0 })}
          data-testid={`${tp}-range-end`}
        />
      </div>
    </>
  )
}
