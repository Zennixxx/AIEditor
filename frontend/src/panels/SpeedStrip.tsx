import { effectiveSpeedFn } from '@/model/clipTime'
import type { Clip } from '@/shared/types.gen'
import { speedColor } from '@/timeline/speedColor'
import styles from './Inspector.module.css'

const SEGMENTS = 48

export function SpeedStrip({ clip, onOpen }: { clip: Clip; onOpen: () => void }) {
  const fn = effectiveSpeedFn(clip)
  const W = 220
  const H = 28
  const ys = (v: number) => H / 2 - (Math.log10(Math.max(v, 0.1)) / 1) * (H / 2 - 2)
  const pts: string[] = []
  const rects = []
  for (let i = 0; i < SEGMENTS; i++) {
    const u = (i + 0.5) / SEGMENTS
    rects.push(
      <rect
        key={i}
        x={(i * W) / SEGMENTS}
        y={H - 4}
        width={W / SEGMENTS + 0.5}
        height={4}
        fill={speedColor(fn(u))}
      />,
    )
  }
  for (let i = 0; i <= SEGMENTS; i++)
    pts.push(`${((i / SEGMENTS) * W).toFixed(1)},${ys(fn(i / SEGMENTS)).toFixed(1)}`)
  return (
    <svg
      className={styles.speedStrip}
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      onDoubleClick={onOpen}
      data-testid="speed-strip"
      aria-label="Профиль скорости (двойной клик — граф-редактор)"
    >
      <line x1={0} x2={W} y1={H / 2} y2={H / 2} className={styles.speedStripMid} />
      <polyline points={pts.join(' ')} />
      {rects}
    </svg>
  )
}
