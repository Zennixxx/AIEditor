import { useMemo } from 'react'
import { MARKER_COLORS, MARKER_KINDS, timelineMarkers } from '@/model/markers'
import type { MarkerKind } from '@/shared/types.gen'
import { useProject } from '@/store/project'
import { useUi } from '@/store/ui'
import styles from './Timeline.module.css'

const KIND_LABELS: Record<MarkerKind, string> = {
  bass: 'bass',
  beat: 'beat',
  downbeat: 'down',
  onset: 'onset',
  manual: 'manual',
  ai: 'ai',
}

/** Фильтр видимости маркеров: порог силы и чекбоксы видов. Скрытые не участвуют в привязке и макро-ops. */
export function MarkerFilter() {
  const vis = useUi((s) => s.markerVisibility)
  const set = useUi((s) => s.setMarkerVisibility)
  const project = useProject((s) => s.project)
  // сколько маркеров проходит фильтр (именно они участвуют в привязке и макро-ops)
  const shown = useMemo(() => timelineMarkers(project, vis).length, [project, vis])

  const toggle = (kind: MarkerKind) =>
    set({ kinds: vis.kinds.includes(kind) ? vis.kinds.filter((k) => k !== kind) : [...vis.kinds, kind] })

  return (
    <div className={styles.markerFilter} data-testid="marker-filter">
      <span className={styles.filterLabel}>Маркеры</span>
      <input
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={vis.minStrength}
        onChange={(e) => set({ minStrength: Number(e.currentTarget.value) })}
        className={styles.threshold}
        onPointerUp={(e) => e.currentTarget.blur()}
        aria-label="Порог силы маркеров"
        title={`Порог силы: ${Math.round(vis.minStrength * 100)}%`}
        data-testid="marker-threshold"
      />
      {MARKER_KINDS.map((kind) => (
        <button
          key={kind}
          aria-pressed={vis.kinds.includes(kind)}
          onClick={() => toggle(kind)}
          title={`Показывать маркеры «${kind}»`}
          data-testid={`marker-kind-${kind}`}
        >
          <span className={styles.dot} style={{ background: MARKER_COLORS[kind] }} />
          {KIND_LABELS[kind]}
        </button>
      ))}
      <span className={styles.filterCount} data-testid="marker-count" title="Маркеров проходит фильтр">
        {shown}
      </span>
    </div>
  )
}
