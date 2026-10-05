import * as actions from '@/app/actions'
import { envelopeAt } from '@/model/envelope'
import { findEffect, findMarker } from '@/model/lookup'
import { hasRenderer } from '@/render/effects'
import { CATEGORY_LABELS, getEffectDef, resolveParams } from '@/shared/effects-registry'
import type { EffectItem, EffectParamDef, Envelope, Project } from '@/shared/types.gen'
import { useProject } from '@/store/project'
import styles from './Inspector.module.css'

const CURVES: { value: Envelope['curve']; label: string }[] = [
  { value: 'exp', label: 'Экспонента' },
  { value: 'easeOut', label: 'Плавно' },
  { value: 'linear', label: 'Линейно' },
]

const seal = () => useProject.getState().sealHistory()

/** Мини-график огибающей × strength (CONTRACT §2.1). */
function EnvelopeGraph({ item }: { item: EffectItem }) {
  const W = 200
  const H = 36
  const N = 64
  const pts: string[] = []
  for (let i = 0; i <= N; i++) {
    const tau = (i / N) * item.duration * 0.9999
    pts.push(
      `${((i / N) * W).toFixed(1)},${(H - 2 - envelopeAt(item.envelope, item.duration, tau) * (H - 4)).toFixed(1)}`,
    )
  }
  return (
    <svg className={styles.graph} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden>
      <polyline points={pts.join(' ')} />
    </svg>
  )
}

function ParamControl({ item, def }: { item: EffectItem; def: EffectParamDef }) {
  const value = resolveParams(item.effect, item.params)[def.key]
  const overridden = def.key in item.params
  const set = (v: number | string | boolean, merge = true) =>
    actions.updateEffect(
      item.id,
      { params: { ...item.params, [def.key]: v } },
      merge ? `param:${def.key}` : undefined,
    )
  const reset = () => {
    const rest = { ...item.params }
    delete rest[def.key]
    actions.updateEffect(item.id, { params: rest })
  }
  const testId = `fx-param-${def.key}`
  let control
  switch (def.type) {
    case 'number': {
      const n = typeof value === 'number' ? value : Number(def.default)
      const clamp = (v: number) => Math.min(def.max ?? Infinity, Math.max(def.min ?? -Infinity, v))
      control = (
        <span className={styles.paramInputs}>
          <input
            type="range"
            min={def.min}
            max={def.max}
            step={def.step ?? 0.01}
            value={n}
            onChange={(e) => set(Number(e.currentTarget.value))}
            onPointerUp={seal}
            data-testid={testId}
          />
          <input
            type="number"
            min={def.min}
            max={def.max}
            step={def.step ?? 0.01}
            value={n}
            onChange={(e) => {
              const v = Number(e.currentTarget.value)
              if (Number.isFinite(v)) set(clamp(v))
            }}
            onBlur={seal}
          />
        </span>
      )
      break
    }
    case 'boolean':
      control = (
        <input
          type="checkbox"
          checked={value === true}
          onChange={(e) => set(e.currentTarget.checked, false)}
          data-testid={testId}
        />
      )
      break
    case 'color':
      control = (
        <input
          type="color"
          value={typeof value === 'string' ? value.slice(0, 7) : '#ffffff'}
          onChange={(e) => set(e.currentTarget.value)}
          onBlur={seal}
          data-testid={testId}
        />
      )
      break
    case 'enum':
      control = (
        <select
          value={String(value)}
          onChange={(e) => set(e.currentTarget.value, false)}
          data-testid={testId}
        >
          {(def.options ?? []).map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      )
      break
  }
  return (
    <div className={styles.param}>
      <span className={styles.paramLabel} title={def.key}>
        {def.label}
        {def.unit ? `, ${def.unit}` : ''}
      </span>
      {control}
      <button
        type="button"
        className={styles.reset}
        disabled={!overridden}
        onClick={reset}
        title="Значение по умолчанию"
        aria-label={`Сбросить ${def.label}`}
      >
        ↺
      </button>
    </div>
  )
}

function NumberField({
  label,
  value,
  min,
  step,
  onChange,
  testId,
}: {
  label: string
  value: number
  min: number
  step: number
  onChange: (v: number) => void
  testId?: string
}) {
  return (
    <label className={styles.field}>
      <span>{label}</span>
      <input
        type="number"
        min={min}
        step={step}
        value={Number(value.toFixed(4))}
        onChange={(e) => {
          const v = Number(e.currentTarget.value)
          if (Number.isFinite(v) && v >= min) onChange(v)
        }}
        onBlur={seal}
        data-testid={testId}
      />
    </label>
  )
}

/** Инспектор эффекта: параметры по реестру, огибающая, время, привязка к маркеру. */
export function EffectEditor({ effectId }: { effectId: string }) {
  // селекторы возвращают объекты проекта (стабильные ссылки), а не новый EffectRef на каждый вызов
  const item = useProject((s) => findEffect(s.project, effectId)?.effect)
  const inClip = useProject((s) => !!findEffect(s.project, effectId)?.clip)
  const anchorMarker = useProject((s) => {
    const id = findEffect(s.project, effectId)?.effect.anchor?.markerId
    return id ? findMarker(s.project, id)?.marker : undefined
  })
  if (!item) return null
  const def = getEffectDef(item.effect)
  if (!def) return <div className={styles.error}>Неизвестный эффект {item.effect}</div>
  const env = item.envelope
  const setEnv = (patch: Partial<Envelope>, key: string) =>
    actions.updateEffect(item.id, { envelope: { ...env, ...patch } }, `env:${key}`)

  return (
    <section
      className={styles.section}
      data-testid="effect-editor"
      data-effect={item.effect}
      aria-label="Эффект"
    >
      <h3 className={styles.heading}>
        {def.name} <span className={styles.dimText}>· {CATEGORY_LABELS[def.category]}</span>
      </h3>
      {!hasRenderer(def.id) && (
        <div className={styles.hint}>Шейдер этого эффекта — в следующей фазе, в превью он не виден.</div>
      )}
      <div className={styles.inlineRow}>
        <label className={styles.check}>
          <input
            type="checkbox"
            checked={item.enabled}
            onChange={(e) => actions.updateEffect(item.id, { enabled: e.currentTarget.checked })}
            data-testid="fx-enabled"
          />
          Включён
        </label>
        <button
          type="button"
          className={styles.small}
          onClick={() => actions.removeEffect(item.id)}
          data-testid="fx-remove"
        >
          Удалить
        </button>
      </div>
      <div className={styles.fields}>
        <NumberField
          label={inClip ? 'Начало от клипа, с' : 'Начало, с'}
          value={item.start}
          min={0}
          step={0.01}
          onChange={(v) => actions.updateEffect(item.id, { start: v }, 'start')}
        />
        <NumberField
          label="Длительность, с"
          value={item.duration}
          min={0.01}
          step={0.01}
          onChange={(v) => v > 0 && actions.updateEffect(item.id, { duration: v }, 'duration')}
          testId="fx-duration-input"
        />
      </div>

      {def.params.map((p) => (
        <ParamControl key={p.key} item={item} def={p} />
      ))}

      <div className={styles.subheading}>Огибающая</div>
      <EnvelopeGraph item={item} />
      <div className={styles.fields}>
        <NumberField
          label="Атака"
          value={env.attack}
          min={0}
          step={0.01}
          onChange={(v) => setEnv({ attack: v }, 'attack')}
        />
        <NumberField
          label="Удержание"
          value={env.hold}
          min={0}
          step={0.01}
          onChange={(v) => setEnv({ hold: v }, 'hold')}
        />
        <NumberField
          label="Затухание"
          value={env.decay}
          min={0}
          step={0.01}
          onChange={(v) => setEnv({ decay: v }, 'decay')}
        />
        <label className={styles.field}>
          <span>Кривая</span>
          <select
            value={env.curve}
            onChange={(e) =>
              actions.updateEffect(item.id, {
                envelope: { ...env, curve: e.currentTarget.value as Envelope['curve'] },
              })
            }
          >
            {CURVES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {item.anchor && (
        <div className={styles.inlineRow} data-testid="fx-anchor">
          <span className={styles.meta}>
            Привязан к маркеру{' '}
            {anchorMarker ? `${anchorMarker.kind} ${anchorMarker.t.toFixed(3)} с` : item.anchor.markerId}
          </span>
          <button
            type="button"
            className={styles.small}
            onClick={() => {
              // снять привязку: anchor удаляется через полную замену эффекта (patch не умеет удалять поле)
              useProject.getState().transact(
                (d) => {
                  const r = findEffect(d as Project, item.id)
                  if (r) delete r.effect.anchor
                },
                { label: 'Отвязать эффект от маркера' },
              )
            }}
          >
            Отвязать
          </button>
        </div>
      )}
    </section>
  )
}
