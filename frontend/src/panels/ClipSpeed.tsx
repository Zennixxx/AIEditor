import { useState } from 'react'
import * as actions from '@/app/actions'
import { minEffectiveSpeed, requiredFactor, usableInterpolation } from '@/model/interpolation'
import { findClip } from '@/model/lookup'
import { assetLookup } from '@/playback/player'
import { rampPresets } from '@/shared/rampPresets'
import type { Clip, TimeRemapFit } from '@/shared/types.gen'
import { useAssets } from '@/store/assets'
import { useInterpolation } from '@/store/interpolation'
import { useProject, type DispatchResult } from '@/store/project'
import { useUi } from '@/store/ui'
import styles from './Inspector.module.css'
import { SpeedStrip } from './SpeedStrip'

const seal = () => useProject.getState().sealHistory()

function fmt(v: number): string {
  return `×${v >= 10 ? v.toFixed(0) : v >= 1 ? v.toFixed(2) : v.toFixed(3)}`
}

export function ClipSpeed({ clipId }: { clipId: string }) {
  const clip = useProject((s) => findClip(s.project, clipId)?.clip)
  const project = useProject((s) => s.project)
  useAssets((s) => s.assets)
  const interp = useInterpolation((s) => s.byClip[clipId])
  const [presetId, setPresetId] = useState(rampPresets[0]?.id ?? '')
  const [message, setMessage] = useState<string | null>(null)
  if (!clip) return null
  const remap = clip.timeRemap

  const report = (res: DispatchResult | null, ok?: string) => {
    if (!res) return
    setMessage(res.ok ? (ok ?? null) : res.error.message)
  }

  return (
    <section className={styles.section} data-testid="clip-speed" aria-label="Скорость">
      <h3 className={styles.heading}>
        Скорость <span className={styles.dimText}>· мин. {fmt(minEffectiveSpeed(clip))}</span>
      </h3>
      <div className={styles.easeRow} role="group" aria-label="Режим скорости">
        <button
          type="button"
          className={styles.small}
          aria-pressed={!remap}
          onClick={() => report(actions.setTimeRemap(clip.id, null))}
          disabled={!remap}
          data-testid="speed-mode-constant"
        >
          Константа
        </button>
        <button
          type="button"
          className={styles.small}
          aria-pressed={!!remap}
          onClick={() => report(actions.enableSpeedCurve(clip.id))}
          disabled={!!remap}
          data-testid="speed-mode-curve"
        >
          Кривая
        </button>
        <button
          type="button"
          className={styles.small}
          onClick={() => useUi.getState().openCurveEditor(clip.id)}
          title="Граф-редактор скорости (Shift+F3, двойной клик по полоске скорости на клипе)"
          data-testid="speed-open-graph"
        >
          Граф…
        </button>
      </div>
      {remap ? (
        <CurveControls clip={clip} report={report} />
      ) : (
        <ConstantControls clip={clip} report={report} />
      )}
      <label className={styles.check}>
        <input
          type="checkbox"
          checked={clip.reverse}
          onChange={(e) => report(actions.setClipReverse(clip.id, e.currentTarget.checked))}
          data-testid="speed-reverse"
        />
        Обратно (reverse)
      </label>
      <div className={styles.subheading}>Пресет</div>
      <div className={styles.inlineRow}>
        <select
          value={presetId}
          onChange={(e) => setPresetId(e.currentTarget.value)}
          aria-label="Пресет скорости"
          data-testid="ramp-preset"
        >
          {rampPresets.map((p) => (
            <option key={p.id} value={p.id} title={p.description}>
              {p.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          className={styles.small}
          onClick={() => report(actions.applyRampPreset(clip.id, presetId))}
          data-testid="ramp-apply"
        >
          Применить
        </button>
        <button
          type="button"
          className={styles.small}
          title="Пресет так, чтобы замедление попало на видимые маркеры внутри клипа"
          onClick={() => {
            const res = actions.velocityBetweenMarkers(clip.id, presetId)
            if (!res) return
            report(
              res.result,
              res.matched > 0
                ? `Замедление на ${res.matched === 1 ? 'маркере' : 'маркерах'}`
                : 'Внутри клипа нет подходящих маркеров — пресет без подгонки',
            )
          }}
          data-testid="ramp-velocity"
        >
          По маркерам
        </button>
      </div>
      <InterpolationStatus clip={clip} fps={project.fps} running={interp} />
      {message && (
        <div className={styles.hint} data-testid="speed-message">
          {message}
        </div>
      )}
    </section>
  )
}

function ConstantControls({ clip, report }: { clip: Clip; report: (res: DispatchResult | null) => void }) {
  return (
    <div className={styles.param}>
      <span className={styles.paramLabel}>Скорость, %</span>
      <span className={styles.paramInputs}>
        <input
          type="number"
          min={5}
          max={1000}
          step={5}
          value={Number((clip.speed * 100).toFixed(1))}
          onChange={(e) => {
            const v = Number(e.currentTarget.value)
            if (Number.isFinite(v) && v >= 5) report(actions.setClipSpeed(clip.id, v / 100, 'input'))
          }}
          onBlur={seal}
          data-testid="speed-constant"
        />
      </span>
      <span />
    </div>
  )
}

function CurveControls({ clip, report }: { clip: Clip; report: (res: DispatchResult | null) => void }) {
  const remap = clip.timeRemap!
  return (
    <>
      <div className={styles.param}>
        <span className={styles.paramLabel}>Длительность</span>
        <span className={styles.paramInputs}>
          <select
            value={remap.fit}
            onChange={(e) =>
              report(actions.setTimeRemap(clip.id, { ...remap, fit: e.currentTarget.value as TimeRemapFit }))
            }
            data-testid="ramp-fit"
          >
            <option value="stretch">Растянуть по клипу</option>
            <option value="free">Свободно (sourceOut по кривой)</option>
          </select>
        </span>
        <span />
      </div>
      <label className={styles.check}>
        <input
          type="checkbox"
          checked={remap.frameBlend}
          onChange={(e) =>
            report(actions.setTimeRemap(clip.id, { ...remap, frameBlend: e.currentTarget.checked }))
          }
          data-testid="ramp-frame-blend"
        />
        Смешивать соседние кадры, пока нет интерполяции
      </label>
      <SpeedStrip clip={clip} onOpen={() => useUi.getState().openCurveEditor(clip.id)} />
    </>
  )
}

function InterpolationStatus({
  clip,
  fps,
  running,
}: {
  clip: Clip
  fps: number
  running: ReturnType<typeof useInterpolation.getState>['byClip'][string] | undefined
}) {
  const lookup = assetLookup(useProject.getState().project)
  const factor = requiredFactor(clip, lookup(clip.assetId), fps)
  const usable = usableInterpolation(clip, lookup)
  let text: string
  let state: string
  if (running?.status === 'running') {
    state = 'running'
    text = `Интерполяция кадров… ${Math.round(running.progress * 100)}%`
  } else if (running?.status === 'failed') {
    state = 'failed'
    text = `Интерполяция не удалась: ${running.error ?? ''}`
  } else if (usable?.parent) {
    state = 'ready'
    const how = usable.parent.quality === 'fallback' ? 'ffmpeg (fallback)' : 'RIFE'
    text = `Интерполяция ×${usable.parent.factor} готова · ${how}`
  } else if (factor !== null) {
    state = 'pending'
    text = `Нужна интерполяция ×${factor}${clip.timeRemap?.frameBlend ? ', пока — смешивание кадров' : ''}`
  } else {
    state = 'none'
    text = 'Интерполяция не нужна'
  }
  return (
    <div className={styles.hint} data-testid="interp-status" data-state={state}>
      {text}
      {running?.status === 'running' && (
        <div className={styles.bar}>
          <div className={styles.fill} style={{ width: `${Math.round(running.progress * 100)}%` }} />
        </div>
      )}
    </div>
  )
}
