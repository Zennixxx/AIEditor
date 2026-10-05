import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { removeTrack } from '@/app/actions'
import { planTrackMove, trackGroup } from '@/model/tracks'
import type { EditOp, Track } from '@/shared/types.gen'
import { useProject } from '@/store/project'
import { useUi } from '@/store/ui'
import { RULER_H, type TrackRow } from './geometry'
import styles from './Timeline.module.css'

type Flag = 'muted' | 'locked' | 'hidden'
type TrackPatch = Extract<EditOp, { op: 'updateTrack' }>['patch']

function updateTrack(track: Track, patch: TrackPatch, label: string, mergeKey?: string): void {
  useProject
    .getState()
    .dispatch([{ op: 'updateTrack', trackId: track.id, patch }], { label, ...(mergeKey ? { mergeKey } : {}) })
}

function setFlag(track: Track, flag: Flag): void {
  const labels: Record<Flag, string> = { muted: 'Mute', locked: 'Блокировка', hidden: 'Скрыть' }
  updateTrack(track, { [flag]: !track[flag] }, `${labels[flag]} ${track.name}`)
}

function rename(track: Track, name: string): void {
  const next = name.trim()
  if (!next || next === track.name) return
  updateTrack(track, { name: next }, 'Переименовать дорожку')
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
      const op =
        latest !== row.index ? planTrackMove(useProject.getState().project, row.track.id, latest) : null
      if (op) useProject.getState().dispatch([op], { label: 'Переставить дорожку' })
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
                {t.kind === 'audio' && <VolumeSlider track={t} />}
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

let volumeSeq = 0

/** Громкость аудиодорожки 0..2 (op updateTrack); непрерывное перетаскивание — одна запись истории. */
function VolumeSlider({ track }: { track: Track }) {
  const [key, setKey] = useState<string | null>(null)
  const volume = track.volume ?? 1
  return (
    <input
      type="range"
      className={styles.volume}
      min={0}
      max={2}
      step={0.01}
      value={volume}
      aria-label={`Громкость ${track.name}`}
      title={`Громкость ${Math.round(volume * 100)}% (двойной клик — 100%)`}
      onPointerDown={() => setKey(`volume:${track.id}:${++volumeSeq}`)}
      onPointerUp={() => {
        setKey(null)
        useProject.getState().sealHistory()
      }}
      onDoubleClick={() => updateTrack(track, { volume: 1 }, 'Громкость дорожки')}
      onChange={(e) =>
        updateTrack(track, { volume: Number(e.currentTarget.value) }, 'Громкость дорожки', key ?? undefined)
      }
    />
  )
}
