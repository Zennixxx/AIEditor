import type { ReactNode } from 'react'
import styles from './Panel.module.css'

interface PanelProps {
  title: string
  actions?: ReactNode
  children: ReactNode
}

export function Panel({ title, actions, children }: PanelProps) {
  return (
    <section className={styles.panel} aria-label={title}>
      <header className={styles.header}>
        <h2 className={styles.title}>{title}</h2>
        {actions && <div className={styles.actions}>{actions}</div>}
      </header>
      <div className={styles.body}>{children}</div>
    </section>
  )
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className={styles.empty}>
      <div className={styles.emptyTitle}>{title}</div>
      {hint && <div className={styles.emptyHint}>{hint}</div>}
    </div>
  )
}
