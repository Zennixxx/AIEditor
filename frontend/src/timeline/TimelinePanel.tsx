import * as actions from '@/app/actions'
import { Panel } from '@/panels/Panel'
import { formatTimecode } from '@/shared/time'
import { canRedo, canUndo, useProject } from '@/store/project'
import { useUi } from '@/store/ui'
import { MarkerFilter } from './MarkerFilter'
import { Timeline } from './Timeline'
import styles from './Timeline.module.css'

function Toolbar() {
  const tool = useUi((s) => s.tool)
  const snap = useUi((s) => s.snapEnabled)
  const playhead = useUi((s) => s.playhead)
  const fps = useProject((s) => s.project.fps)
  const undoable = useProject(canUndo)
  const redoable = useProject(canRedo)
  const setTool = useUi((s) => s.setTool)

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
      <Timeline />
    </Panel>
  )
}
