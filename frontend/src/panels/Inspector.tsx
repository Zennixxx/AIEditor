import { findClip, findEffect } from '@/model/lookup'
import { canHoldAnalysis } from '@/model/markers'
import { useProject } from '@/store/project'
import { useUi } from '@/store/ui'
import { AnalysisPanel } from './AnalysisPanel'
import { ClipEffects } from './ClipEffects'
import { EffectEditor } from './EffectEditor'
import styles from './Inspector.module.css'
import { MarkerEditor } from './MarkerEditor'
import { EmptyState, Panel } from './Panel'

export function Inspector() {
  const project = useProject((s) => s.project)
  const selection = useUi((s) => s.selection)
  const markerSelection = useUi((s) => s.markerSelection)

  const markerId = markerSelection.length === 1 ? markerSelection[0]! : null
  // элемент fx-дорожки
  const effectId = selection.length === 1 && findEffect(project, selection[0]!) ? selection[0]! : null
  const videoClipId =
    selection.length === 1 && findClip(project, selection[0]!)?.track.kind === 'video' ? selection[0]! : null
  const analysisClipId = selection.find((id) => canHoldAnalysis(project, id) && findClip(project, id)) ?? null

  return (
    <Panel title="Инспектор">
      {markerId || effectId || videoClipId || analysisClipId ? (
        <div className={styles.inspector}>
          {markerId && <MarkerEditor key={`marker:${markerId}`} markerId={markerId} />}
          {effectId && <EffectEditor key={`fx:${effectId}`} effectId={effectId} />}
          {videoClipId && <ClipEffects key={`clip-fx:${videoClipId}`} clipId={videoClipId} />}
          {analysisClipId && <AnalysisPanel key={`analysis:${analysisClipId}`} clipId={analysisClipId} />}
        </div>
      ) : (
        <EmptyState title="Ничего не выбрано" hint="Свойства клипа, маркера или эффекта" />
      )}
    </Panel>
  )
}
