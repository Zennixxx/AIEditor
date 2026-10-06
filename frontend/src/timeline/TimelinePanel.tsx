import * as actions from '@/app/actions'
import { CurveEditor } from '@/panels/CurveEditor'
import { Panel } from '@/panels/Panel'
import { formatTimecode } from '@/shared/time'
import { canRedo, canUndo, useProject } from '@/store/project'
import { useUi } from '@/store/ui'
import type { LaneProp } from '@/model/keyframes'
import { MarkerFilter } from './MarkerFilter'
import { Timeline } from './Timeline'
import styles from './Timeline.module.css'
import { LANE_LABELS } from './geometry'

const LANE_BUTTONS: { lane: LaneProp; label: string }[] = [
  { lane: 'position', label: 'P' },
  { lane: 'scale', label: 'S' },
  { lane: 'rotation', label: 'R' },
  { lane: 'opacity', label: 'T' },
]

function Toolbar() {
  const tool = useUi((s) => s.tool)
  const snap = useUi((s) => s.snapEnabled)
  const playhead = useUi((s) => s.playhead)
  const fps = useProject((s) => s.project.fps)
  const undoable = useProject(canUndo)
  const redoable = useProject(canRedo)
  const selection = useUi((s) => s.selection)
  const setTool = useUi((s) => s.setTool)
  const lanes = useUi((s) => s.propLanes)
  const toggleLane = useUi((s) => s.toggleLane)

  return (
    <div className={styles.toolbar}>
      <button onClick={actions.undo} disabled={!undoable} title="Отменить (Ctrl+Z)">
        ↶
      </button>
      <button onClick={actions.redo} disabled={!redoable} title="Повторить (Ctrl+Shift+Z)">
        ↷
      </button>
      <span className={styles.sep} />
      <button aria-pressed={tool === 'select'} onClick={() => setTool('select')} title="Выделение (V)">
        Выделение
      </button>
      <button aria-pressed={tool === 'blade'} onClick={() => setTool('blade')} title="Лезвие (C)">
        Лезвие
      </button>
      <button onClick={actions.splitAtPlayhead} title="Разрезать по плейхеду (Ctrl+K)">
        Разрезать
      </button>
      <button
        aria-pressed={snap}
        onClick={actions.toggleSnap}
        title="Привязка (S), Shift при перетаскивании — временно выключить"
      >
        Привязка
      </button>
      <span className={styles.sep} />
      {LANE_BUTTONS.map((b) => (
        <button
          key={b.lane}
          aria-pressed={lanes.includes(b.lane)}
          onClick={() => toggleLane(b.lane)}
          title={`Дорожка свойства: ${LANE_LABELS[b.lane]}; U — анимированные свойства`}
          data-testid={`lane-toggle-${b.lane}`}
        >
          {b.label}
        </button>
      ))}
      <span className={styles.sep} />
      <button onClick={actions.zoomOut} title="Отдалить (−)">
        −
      </button>
      <button onClick={actions.zoomIn} title="Приблизить (+)">
        +
      </button>
      <button onClick={actions.zoomFit} title="Вписать всё (\)">
        ⇔
      </button>
      <span className={styles.sep} />
      <MarkerFilter />
      <button
        onClick={actions.openCutDialog}
        title="Нарезать выбранные клипы по маркерам"
        data-testid="cut-open"
      >
        Нарезать
      </button>
      <button
        onClick={() => actions.openFxDialog()}
        title="Поставить эффект на маркеры (шейк на каждый бас…)"
        data-testid="fx-open"
      >
        Эффект
      </button>
      <button
        onClick={actions.snapSelectedEdgesToMarkers}
        disabled={selection.length === 0}
        title="Подтянуть края выделенных клипов к ближайшим видимым маркерам"
        data-testid="snap-edges"
      >
        К маркерам
      </button>
      <span className={styles.sep} />
      <button onClick={() => actions.addTrack('video')} title="Добавить видеодорожку">
        +V
      </button>
      <button onClick={() => actions.addTrack('audio')} title="Добавить аудиодорожку">
        +A
      </button>
      <button onClick={() => actions.addTrack('fx')} title="Добавить fx-дорожку (adjustment layer)">
        +FX
      </button>
      <span className={styles.sep} />
      <span className={styles.timecode} data-testid="playhead-timecode">
        {formatTimecode(playhead, fps)}
      </span>
    </div>
  )
}

export function TimelinePanel() {
  return (
    <Panel title="Таймлайн" actions={<Toolbar />}>
      <div className={styles.stack}>
        <CurveEditor />
        <div className={styles.stackMain}>
          <Timeline />
        </div>
      </div>
    </Panel>
  )
}
