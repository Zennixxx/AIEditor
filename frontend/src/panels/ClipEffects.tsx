import * as actions from '@/app/actions'
import { findClip } from '@/model/lookup'
import { getEffectDef } from '@/shared/effects-registry'
import { useProject } from '@/store/project'
import { useUi } from '@/store/ui'
import { EffectEditor } from './EffectEditor'
import styles from './Inspector.module.css'

/** Эффекты выбранного видеоклипа: список (вкл/выкл, удалить), раскрытый — редактор параметров. */
export function ClipEffects({ clipId }: { clipId: string }) {
  const effects = useProject((s) => findClip(s.project, clipId)?.clip.effects)
  const inspected = useUi((s) => s.inspectedEffectId)
  if (!effects) return null
  const open = effects.find((e) => e.id === inspected)
  return (
    <section className={styles.section} data-testid="clip-effects" aria-label="Эффекты клипа">
      <h3 className={styles.heading}>Эффекты клипа</h3>
      {effects.length === 0 ? (
        <div className={styles.hint}>Перетащите эффект из библиотеки на клип</div>
      ) : (
        <ul className={styles.fxList}>
          {effects.map((e) => (
            <li key={e.id} className={styles.fxRow} data-open={e.id === inspected || undefined}>
              <input
                type="checkbox"
                checked={e.enabled}
                onChange={(ev) => actions.updateEffect(e.id, { enabled: ev.currentTarget.checked })}
                aria-label="Включён"
              />
              <button
                type="button"
                className={styles.fxName}
                onClick={() => useUi.getState().inspectEffect(e.id === inspected ? null : e.id)}
                data-testid={`clip-fx-${e.effect}`}
              >
                {getEffectDef(e.effect)?.name ?? e.effect}
                <span className={styles.dimText}>
                  {' '}
                  {e.start.toFixed(2)}–{(e.start + e.duration).toFixed(2)} с
                </span>
              </button>
              <button
                type="button"
                className={styles.reset}
                onClick={() => actions.removeEffect(e.id)}
                aria-label="Удалить эффект"
                title="Удалить"
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
      {open && <EffectEditor key={open.id} effectId={open.id} />}
    </section>
  )
}
