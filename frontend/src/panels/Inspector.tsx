import { findClip } from '@/model/lookup'
import { canHoldAnalysis } from '@/model/markers'
import { useProject } from '@/store/project'
import { useUi } from '@/store/ui'
import { AnalysisPanel } from './AnalysisPanel'
import styles from './Inspector.module.css'
import { MarkerEditor } from './MarkerEditor'
import { EmptyState, Panel } from './Panel'

export function Inspector() {
  const project = useProject((s) => s.project)
  const selection = useUi((s) => s.selection)
  const markerSelection = useUi((s) => s.markerSelection)

  const clipId = selection.find((id) => canHoldAnalysis(project, id) && findClip(project, id)) ?? null
  const markerId = markerSelection.length === 1 ? markerSelection[0]! : null

  return (
    <Panel title="Инспектор">
      {clipId || markerId ? (
        <div className={styles.inspector}>
          {markerId && <MarkerEditor key={markerId} markerId={markerId} />}
          {clipId && <AnalysisPanel key={clipId} clipId={clipId} />}
        </div>
      ) : (
        <EmptyState title="Ничего не выбрано" hint="Свойства клипа, маркера или эффекта" />
      )}
    </Panel>
  )
}
