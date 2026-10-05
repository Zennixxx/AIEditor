import { BackendStatus } from './BackendStatus'
import styles from './TopBar.module.css'

export function TopBar() {
  return (
    <header className={styles.bar}>
      <div className={styles.brand}>
        <span className={styles.logo} aria-hidden>
          ◆
        </span>
        AIEditor
      </div>
      <div className={styles.project}>Без проекта</div>
      <BackendStatus />
    </header>
  )
}
