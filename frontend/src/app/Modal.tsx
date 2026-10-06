import { useEffect, useRef, type ReactNode } from 'react'
import styles from './Dialog.module.css'

interface ModalProps {
  title: string
  testId: string
  wide?: boolean
  onClose: () => void
  /** Escape обрабатывает сам контент (например, во время захвата клавиши). */
  captureEscape?: boolean
  children: ReactNode
}

export function Modal({ title, testId, wide, onClose, captureEscape, children }: ModalProps) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => ref.current?.focus(), [])
  useEffect(() => {
    if (captureEscape) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [captureEscape, onClose])
  return (
    <div className={styles.backdrop} onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={ref}
        tabIndex={-1}
        className={`${styles.dialog} ${wide ? styles.wide : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        data-testid={testId}
      >
        <div className={styles.head}>
          <h2 className={styles.title}>{title}</h2>
          <button className={styles.close} onClick={onClose} aria-label="Закрыть">
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}
