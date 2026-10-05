import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { removeTrack } from '@/app/actions'
import { moveTrackInDisplay, trackGroup } from '@/model/tracks'
import type { Track } from '@/shared/types.gen'
import { useProject } from '@/store/project'
import { useUi } from '@/store/ui'
import { RULER_H, type TrackRow } from './geometry'
import styles from './Timeline.module.css'

type Flag = 'muted' | 'locked' | 'hidden'

function setFlag(track: Track, flag: Flag): void {
  const labels: Record<Flag, string> = { muted: 'Mute', locked: 'Блокировка', hidden: 'Скрыть' }
  useProject.getState().transact(
    (d) => {
      const t = d.tracks.find((x) => x.id === track.id)
      if (t) t[flag] = !t[flag]
    },
    { label: `${labels[flag]} ${track.name}` },
  )
}

function rename(track: Track, name: string): void {
  if (!name.trim() || name === track.name) return
  useProject.getState().transact(
    (d) => {
      const t = d.tracks.find((x) => x.id === track.id)
      if (t) t.name = name.trim()
    },
    { label: 'Переименовать дорожку' },
  )
}

/** Заголовки дорожек (DOM-колонка слева от canvas): имя, M/L/H/S, удаление, перестановка drag-ом. */
export function TrackHeaders({ rows, scrollY }: { rows: readonly TrackRow[]; scrollY: number }) {
  const solo = useUi((s) => s.solo)
  const toggleSolo = useUi((s) => s.toggleSolo)
  const [editing, setEditing] = useState<string | null>(null)
  const [drag, setDrag] = useState<{ id: string; target: number; y: number } | null>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const startReorder = (row: TrackRow, e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    const list = listRef.current
    if (!list) return
    e.preventDefault()
    const handle = e.currentTarget
    handle.setPointerCapture(e.pointerId)
    const group = trackGroup(row.track)
    const targetAt = (clientY: number) => {
      const y = clientY - list.getBoundingClientRect().top + scrollY
      const same = rows.filter((r) => trackGroup(r.track) === group)
      let idx = same[same.length - 1]!.index
      for (const r of same) {
        if (y < r.top + r.height / 2) {
          idx = r.index
          break
        }
      }
      return { target: idx, y }
    }
    setDrag({ id: row.track.id, ...targetAt(e.clientY) })
    let latest = row.index
    const onMove = (ev: PointerEvent) => {
      const t = targetAt(ev.clientY)
      latest = t.target
      setDrag({ id: row.track.id, ...t })
    }
    const onUp = () => {
      handle.removeEventListener('pointermove', onMove)
      handle.removeEventListener('pointerup', onUp)
      handle.removeEventListener('pointercancel', onUp)
      setDrag(null)
      if (latest !== row.index) {
        useProject.getState().transact((d) => void moveTrackInDisplay(d, row.track.id, latest), {
          label: 'Переставить дорожку',
        })
      }
    }
    handle.addEventListener('pointermove', onMove)
    handle.addEventListener('pointerup', onUp)
    handle.addEventListener('pointercancel', onUp)
  }

  const dropRow = drag ? rows.find((r) => r.index === drag.target) : undefined

  return (
    <div className={styles.headers}>
      <div className={styles.rulerSpacer} style={{ height: RULER_H }} />
      <div className={styles.headerList} ref={listRef}>
        <div style={{ transform: `translateY(${-scrollY}px)` }}>
          {rows.map((row) => {
            const t = row.track
            return (
              <div
                key={t.id}
                className={styles.trackHeader}
                data-kind={t.kind}
                data-dragging={drag?.id === t.id || undefined}
                style={{ height: row.height }}
                data-testid={`track-header-${t.name}`}
              >
                <div
                  className={styles.grip}
                  title="Перетащите, чтобы переставить"
                  onPointerDown={(e) => startReorder(row, e)}
                >
                  ⋮⋮
                </div>
                {editing === t.id ? (
                  <input
                    className={styles.nameInput}
                    defaultValue={t.name}
                    autoFocus
                    onBlur={(e) => {
                      rename(t, e.currentTarget.value)
                      setEditing(null)
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') e.currentTarget.blur()
                      if (e.key === 'Escape') setEditing(null)
                    }}
                  />
                ) : (
                  <span
                    className={styles.trackName}
                    title="Двойной клик — переименовать"
                    onDoubleClick={() => setEditing(t.id)}
                  >
                    {t.name}
                  </span>
                )}
                <div className={styles.trackButtons}>
                  {t.kind !== 'fx' && (
                    <ToggleButton on={t.muted} label="M" title="Mute" onClick={() => setFlag(t, 'muted')} />
                  )}
                  {t.kind === 'audio' && (
                    <ToggleButton
                      on={solo.includes(t.id)}
                      label="S"
                      title="Solo"
                      onClick={() => toggleSolo(t.id)}
                    />
                  )}
                  {t.kind !== 'audio' && (
                    <ToggleButton
                      on={t.hidden}
                      label="H"
                      title="Скрыть"
                      onClick={() => setFlag(t, 'hidden')}
                    />
                  )}
                  <ToggleButton
                    on={t.locked}
                    label="L"
                    title="Заблокировать"
                    onClick={() => setFlag(t, 'locked')}
                  />
                  <button
                    className={styles.iconButton}
                    title="Удалить дорожку"
                    onClick={() => removeTrack(t.id)}
                  >
                    ×
                  </button>
                </div>
              </div>
            )
          })}
          {dropRow && (
            <div
              className={styles.dropLine}
              style={{
                top:
                  drag!.target > (rows.find((r) => r.track.id === drag!.id)?.index ?? 0)
                    ? dropRow.top + dropRow.height
                    : dropRow.top,
              }}
            />
          )}
        </div>
      </div>
    </div>
  )
}

function ToggleButton({
  on,
  label,
  title,
  onClick,
}: {
  on: boolean
  label: string
  title: string
  onClick: () => void
}) {
  return (
    <button className={styles.toggle} data-on={on} aria-pressed={on} title={title} onClick={onClick}>
      {label}
    </button>
  )
}
