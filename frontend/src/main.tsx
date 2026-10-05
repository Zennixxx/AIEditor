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

const root = document.getElementById('root')
if (!root) throw new Error('#root not found')

void enableMocks().then(() => {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
})
