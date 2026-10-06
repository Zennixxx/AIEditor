import { useEffect } from 'react'
import { EffectsLibrary } from '@/panels/EffectsLibrary'
import { ExportDialog } from '@/panels/ExportDialog'
import { Inspector } from '@/panels/Inspector'
import { MediaBin } from '@/panels/MediaBin'
import { Preview } from '@/panels/Preview'
import { player } from '@/playback/player'
import { startBackendMonitor } from '@/store/backend'
import { startInterpolationSync } from '@/store/interpolation'
import { startDataSync } from '@/store/sync'
import { CutDialog } from '@/timeline/CutDialog'
import { FxDialog } from '@/timeline/FxDialog'
import { TimelinePanel } from '@/timeline/TimelinePanel'
import styles from './App.module.css'
import { SplitPane } from './SplitPane'
import { installHotkeys } from './hotkeys'
import { TopBar } from './TopBar'

export function App() {
  useEffect(() => startBackendMonitor(), [])
  useEffect(() => startDataSync(), [])
  useEffect(() => startInterpolationSync(), [])
  useEffect(() => installHotkeys(), [])
  useEffect(() => player.start(), [])

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
            <Inspector />
          </SplitPane>
          <TimelinePanel />
        </SplitPane>
      </main>
      <CutDialog />
      <FxDialog />
      <ExportDialog />
    </div>
  )
}
