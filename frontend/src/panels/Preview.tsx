import { formatTimecode } from '@/shared/time'
import { useProject } from '@/store/project'
import { useUi } from '@/store/ui'
import { EmptyState, Panel } from './Panel'
import styles from './Preview.module.css'

export function Preview() {
  const playhead = useUi((s) => s.playhead)
  const fps = useProject((s) => s.project.fps)
  return (
    <Panel title="Превью">
      <div className={styles.wrap}>
        <div className={styles.viewport}>
          <EmptyState title="Превью" hint="Воспроизведение — фаза 1b, рендер WebGL — фаза 4" />
        </div>
        <div className={styles.transport}>
          <span className={styles.timecode}>{formatTimecode(playhead, fps)}</span>
        </div>
      </div>
    </Panel>
  )
}
