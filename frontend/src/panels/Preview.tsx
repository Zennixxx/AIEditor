import { formatTimecode } from '@/shared/time'
import { EmptyState, Panel } from './Panel'
import styles from './Preview.module.css'

export function Preview() {
  return (
    <Panel title="Превью">
      <div className={styles.wrap}>
        <div className={styles.viewport}>
          <EmptyState title="Превью" hint="Рендер WebGL — фаза 4" />
        </div>
        <div className={styles.transport}>
          <span className={styles.timecode}>{formatTimecode(0, 30)}</span>
        </div>
      </div>
    </Panel>
  )
}
