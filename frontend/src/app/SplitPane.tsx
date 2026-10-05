import {
  Children,
  Fragment,
  useCallback,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'
import styles from './SplitPane.module.css'

interface SplitPaneProps {
  /** Ключ для сохранения размеров в localStorage. */
  id: string
  direction: 'row' | 'column'
  /** Начальные доли (сумма нормализуется). */
  initial: number[]
  /** Минимальные размеры панелей в px. */
  min?: number[]
  children: ReactNode
}

const HANDLE_PX = 4

function loadSizes(id: string, count: number): number[] | null {
  try {
    const raw = localStorage.getItem(`split:${id}`)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (
      Array.isArray(parsed) &&
      parsed.length === count &&
      parsed.every((n) => typeof n === 'number' && n > 0)
    ) {
      return parsed as number[]
    }
  } catch {
    // localStorage недоступен — используем initial
  }
  return null
}

function saveSizes(id: string, sizes: number[]): void {
  try {
    localStorage.setItem(`split:${id}`, JSON.stringify(sizes))
  } catch {
    // игнорируем
  }
}

function normalize(sizes: number[]): number[] {
  const sum = sizes.reduce((a, b) => a + b, 0) || 1
  return sizes.map((s) => s / sum)
}

/** Панели с перетаскиваемыми разделителями; размеры сохраняются между сессиями. */
export function SplitPane({ id, direction, initial, min = [], children }: SplitPaneProps) {
  const items = Children.toArray(children)
  const [sizes, setSizes] = useState(() => loadSizes(id, items.length) ?? normalize(initial))
  const containerRef = useRef<HTMLDivElement>(null)

  const startDrag = useCallback(
    (index: number, e: ReactPointerEvent<HTMLDivElement>) => {
      const container = containerRef.current
      if (!container) return
      e.preventDefault()
      const handle = e.currentTarget
      handle.setPointerCapture(e.pointerId)
      const rect = container.getBoundingClientRect()
      const total = (direction === 'row' ? rect.width : rect.height) - HANDLE_PX * (items.length - 1)
      const startPos = direction === 'row' ? e.clientX : e.clientY
      const start = [...sizes]
      const pairPx = ((start[index] ?? 0) + (start[index + 1] ?? 0)) * total
      const minA = min[index] ?? 80
      const minB = min[index + 1] ?? 80
      let latest = start

      const onMove = (ev: PointerEvent) => {
        const delta = (direction === 'row' ? ev.clientX : ev.clientY) - startPos
        const aPx = Math.min(Math.max((start[index] ?? 0) * total + delta, minA), pairPx - minB)
        const next = [...start]
        next[index] = aPx / total
        next[index + 1] = (pairPx - aPx) / total
        latest = next
        setSizes(next)
      }
      const onUp = () => {
        handle.removeEventListener('pointermove', onMove)
        handle.removeEventListener('pointerup', onUp)
        handle.removeEventListener('pointercancel', onUp)
        saveSizes(id, latest)
      }
      handle.addEventListener('pointermove', onMove)
      handle.addEventListener('pointerup', onUp)
      handle.addEventListener('pointercancel', onUp)
    },
    [direction, id, items.length, min, sizes],
  )

  return (
    <div ref={containerRef} className={styles.split} data-direction={direction}>
      {items.map((child, i) => (
        <Fragment key={i}>
          {i > 0 && (
            <div
              className={styles.handle}
              role="separator"
              aria-orientation={direction === 'row' ? 'vertical' : 'horizontal'}
              onPointerDown={(e) => startDrag(i - 1, e)}
            />
          )}
          <div className={styles.pane} style={{ flex: `${sizes[i] ?? 1} 1 0` }}>
            {child}
          </div>
        </Fragment>
      ))}
    </div>
  )
}
