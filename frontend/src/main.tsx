import '@fontsource-variable/inter'
import './app/theme.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './app/App'

async function enableMocks(): Promise<void> {
  // Проверка прямо по env, чтобы в прод-сборке ветка с MSW вырезалась целиком
  if (import.meta.env.VITE_MOCK !== '1') return
  const { worker } = await import('./api/mocks/browser')
  await worker.start({ onUnhandledRequest: 'bypass', quiet: true })
}

async function exposeDebug(): Promise<void> {
  // dev: сторы доступны из консоли и e2e (window.__aieditor) — проверка превью, замер fps
  if (!import.meta.env.DEV) return
  const [{ useProject }, { useUi }, { player }] = await Promise.all([
    import('./store/project'),
    import('./store/ui'),
    import('./playback/player'),
  ])
  ;(window as unknown as Record<string, unknown>).__aieditor = { useProject, useUi, player }
}

const root = document.getElementById('root')
if (!root) throw new Error('#root not found')

void Promise.all([enableMocks(), exposeDebug()]).then(() => {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
})
