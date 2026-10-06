import { useEffect } from 'react'
import { AutoEditWizard } from '@/ai/AutoEditWizard'
import { AIPanel } from '@/panels/AIPanel'
import { EffectsLibrary } from '@/panels/EffectsLibrary'
import { ExportDialog } from '@/panels/ExportDialog'
import { Inspector } from '@/panels/Inspector'
import { MediaBin } from '@/panels/MediaBin'
import { Preview } from '@/panels/Preview'
import { player } from '@/playback/player'
import { startBackendMonitor } from '@/store/backend'
import { startInterpolationSync } from '@/store/interpolation'
import { restoreLastProject, startAutosave } from '@/store/projectIo'
import { startDataSync } from '@/store/sync'
import { useUi } from '@/store/ui'
import { CutDialog } from '@/timeline/CutDialog'
import { FxDialog } from '@/timeline/FxDialog'
import { TimelinePanel } from '@/timeline/TimelinePanel'
import styles from './App.module.css'
import { HotkeysDialog } from './HotkeysDialog'
import { ProjectsDialog } from './ProjectsDialog'
import { SettingsDialog } from './SettingsDialog'
import { SplitPane } from './SplitPane'
import { installHotkeys } from './hotkeys'
import { TopBar } from './TopBar'

export function App() {
  useEffect(() => startBackendMonitor(), [])
  useEffect(() => startDataSync(), [])
  useEffect(() => startInterpolationSync(), [])
  useEffect(() => installHotkeys(), [])
  useEffect(() => player.start(), [])
  useEffect(() => startAutosave(), [])
  useEffect(() => {
    void restoreLastProject()
  }, [])
  const modal = useUi((s) => s.modal)

  return (
    <div className={styles.app}>
      <TopBar />
      <main className={styles.workspace}>
        <SplitPane id="main-vertical" direction="column" initial={[0.58, 0.42]} min={[200, 160]}>
          <SplitPane id="top-row" direction="row" initial={[0.2, 0.55, 0.25]} min={[180, 320, 220]}>
            <SplitPane id="left-column" direction="column" initial={[0.55, 0.45]} min={[120, 100]}>
              <MediaBin />
              <EffectsLibrary />
            </SplitPane>
            <Preview />
            <SplitPane id="right-column" direction="column" initial={[0.42, 0.58]} min={[120, 200]}>
              <Inspector />
              <AIPanel />
            </SplitPane>
          </SplitPane>
          <TimelinePanel />
        </SplitPane>
      </main>
      <CutDialog />
      <FxDialog />
      <ExportDialog />
      <AutoEditWizard />
      {modal === 'projects' && <ProjectsDialog />}
      {modal === 'settings' && <SettingsDialog />}
      {modal === 'hotkeys' && <HotkeysDialog />}
    </div>
  )
}
