import { useMemo, useState } from 'react'
import * as actions from '@/app/actions'
import { hasRenderer } from '@/render/effects'
import { CATEGORY_LABELS, effectsByCategory } from '@/shared/effects-registry'
import type { EffectDef } from '@/shared/types.gen'
import { useUi } from '@/store/ui'
import { EFFECT_DND_TYPE } from '@/timeline/dnd'
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

/** Библиотека эффектов: категории, поиск; карточку тащат на клип / fx-дорожку или ставят «на маркеры». */
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
  const ready = hasRenderer(def.id)
  return (
    <li
      className={styles.card}
      data-testid={`effect-card-${def.id}`}
      data-ready={ready}
      draggable
      title={`${def.aiHint}${ready ? '' : ' (шейдер — в следующей фазе, в превью пока не виден)'}\nПеретащите на клип или fx-дорожку`}
      onDragStart={(e) => {
        e.dataTransfer.setData(EFFECT_DND_TYPE, def.id)
        e.dataTransfer.setData('text/plain', def.name)
        e.dataTransfer.effectAllowed = 'copy'
        useUi.getState().setDraggingEffect(def.id)
      }}
      onDragEnd={() => useUi.getState().setDraggingEffect(null)}
    >
      <span className={styles.name}>{def.name}</span>
      {def.category !== 'transition' && (
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
