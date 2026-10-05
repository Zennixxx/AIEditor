import { useEffect, useMemo, useState } from 'react'
import * as actions from '@/app/actions'
import { presetEffectsFromSelection, selectionHasEffects } from '@/model/presets'
import { CATEGORY_LABELS, effectsByCategory, getEffectDef } from '@/shared/effects-registry'
import type { EffectDef, EffectPreset } from '@/shared/types.gen'
import { usePresets } from '@/store/presets'
import { useProject } from '@/store/project'
import { useUi } from '@/store/ui'
import { EFFECT_DND_TYPE, PRESET_DND_TYPE } from '@/timeline/dnd'
import styles from './EffectsLibrary.module.css'
import { Panel } from './Panel'

function matches(def: EffectDef, q: string): boolean {
  if (!q) return true
  const s = q.toLowerCase()
  return (
    def.name.toLowerCase().includes(s) ||
    def.id.toLowerCase().includes(s) ||
    def.aiHint.toLowerCase().includes(s)
  )
}

/**
 * Библиотека эффектов: пресеты-комбо и эффекты по категориям, поиск. Карточку тащат на клип / fx-дорожку
 * (переход — на стык), эффект можно поставить «на маркеры», переход — «на все стыки».
 */
export function EffectsLibrary() {
  const [query, setQuery] = useState('')
  const groups = useMemo(() => [...effectsByCategory()], [])

  return (
    <Panel title="Эффекты">
      <div className={styles.library}>
        <input
          className={styles.search}
          type="search"
          placeholder="Поиск эффекта"
          value={query}
          onChange={(e) => setQuery(e.currentTarget.value)}
          data-testid="effects-search"
        />
        <PresetsGroup query={query.trim()} />
        {groups.map(([category, defs]) => {
          const shown = defs.filter((d) => matches(d, query.trim()))
          if (shown.length === 0) return null
          return (
            <section key={category} className={styles.group} aria-label={CATEGORY_LABELS[category]}>
              <h3 className={styles.heading}>{CATEGORY_LABELS[category]}</h3>
              <ul className={styles.list}>
                {shown.map((def) => (
                  <EffectCard key={def.id} def={def} />
                ))}
              </ul>
            </section>
          )
        })}
      </div>
    </Panel>
  )
}

function EffectCard({ def }: { def: EffectDef }) {
  const transition = def.category === 'transition'
  return (
    <li
      className={styles.card}
      data-testid={`effect-card-${def.id}`}
      draggable
      title={`${def.aiHint}
${transition ? 'Перетащите на стык двух клипов' : 'Перетащите на клип или fx-дорожку'}`}
      onDragStart={(e) => {
        e.dataTransfer.setData(EFFECT_DND_TYPE, def.id)
        e.dataTransfer.setData('text/plain', def.name)
        e.dataTransfer.effectAllowed = 'copy'
        useUi.getState().setDraggingEffect(def.id)
      }}
      onDragEnd={() => useUi.getState().setDraggingEffect(null)}
    >
      <span className={styles.name}>{def.name}</span>
      {transition ? (
        <button
          className={styles.apply}
          title="На все стыки выделенных клипов (ничего не выделено — на все стыки)"
          onClick={() => actions.transitionsAtCuts(def.id)}
          data-testid={`effect-to-cuts-${def.id}`}
        >
          ⇄
        </button>
      ) : (
        <button
          className={styles.apply}
          title="Поставить на маркеры…"
          onClick={() => actions.openFxDialog(def.id)}
          data-testid={`effect-to-markers-${def.id}`}
        >
          ⚡
        </button>
      )}
    </li>
  )
}

function PresetsGroup({ query }: { query: string }) {
  const presets = usePresets((s) => s.presets)
  const status = usePresets((s) => s.status)
  const error = usePresets((s) => s.error)
  const project = useProject((s) => s.project)
  const selection = useUi((s) => s.selection)
  const inspected = useUi((s) => s.inspectedEffectId)
  const canSave = selectionHasEffects(project, selection, inspected)
  const [naming, setNaming] = useState(false)
  const [name, setName] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (usePresets.getState().status === 'idle') void usePresets.getState().load()
  }, [])

  const q = query.toLowerCase()
  const shown = presets.filter((p) => !q || p.name.toLowerCase().includes(q))
  if (q && shown.length === 0) return null

  const save = async () => {
    const effects = presetEffectsFromSelection(project, selection, inspected)
    if (effects.length === 0 || !name.trim()) return
    setSaving(true)
    const created = await usePresets.getState().create({ name: name.trim(), effects })
    setSaving(false)
    if (created) {
      setNaming(false)
      setName('')
    }
  }

  return (
    <section className={styles.group} aria-label="Пресеты" data-testid="presets">
      <h3 className={styles.heading}>
        Пресеты
        <button
          className={styles.headingButton}
          disabled={!canSave}
          title={
            canSave
              ? 'Сохранить эффекты выделения как пресет'
              : 'Выделите эффекты или клип с эффектами, чтобы сохранить пресет'
          }
          onClick={() => setNaming((v) => !v)}
          data-testid="preset-save-open"
        >
          ＋
        </button>
      </h3>
      {naming && (
        <form
          className={styles.presetForm}
          onSubmit={(e) => {
            e.preventDefault()
            void save()
          }}
        >
          <input
            className={styles.search}
            autoFocus
            placeholder="Название пресета"
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
            onKeyDown={(e) => e.key === 'Escape' && setNaming(false)}
            data-testid="preset-name"
          />
          <button
            type="submit"
            className={styles.formButton}
            disabled={saving || !name.trim() || !canSave}
            data-testid="preset-save"
          >
            Сохранить
          </button>
        </form>
      )}
      {error && <div className={styles.error}>{error}</div>}
      {status === 'loading' && presets.length === 0 && <div className={styles.hint}>Загрузка…</div>}
      {status === 'ready' && presets.length === 0 && (
        <div className={styles.hint}>Нет пресетов: выделите эффекты и нажмите ＋</div>
      )}
      <ul className={styles.list}>
        {shown.map((p) => (
          <PresetCard key={p.id} preset={p} />
        ))}
      </ul>
    </section>
  )
}

function PresetCard({ preset }: { preset: EffectPreset }) {
  const names = preset.effects.map((e) => getEffectDef(e.effect)?.name ?? e.effect).join(' + ')
  return (
    <li
      className={styles.card}
      data-testid={`preset-card-${preset.id}`}
      data-kind="preset"
      draggable
      title={`${
        preset.description
          ? `${preset.description}
`
          : ''
      }${names}
Перетащите на клип или fx-дорожку`}
      onDragStart={(e) => {
        e.dataTransfer.setData(PRESET_DND_TYPE, preset.id)
        e.dataTransfer.setData('text/plain', preset.name)
        e.dataTransfer.effectAllowed = 'copy'
        useUi.getState().setDraggingPreset(preset.id)
      }}
      onDragEnd={() => useUi.getState().setDraggingPreset(null)}
    >
      <span className={styles.name}>{preset.name}</span>
      <span className={styles.count}>{preset.effects.length}</span>
    </li>
  )
}
