import { defineConfig, devices } from '@playwright/test'

// E2E гоняется в mock-режиме (без бэка) на собственном dev-сервере: отдельный порт (по умолчанию 5174),
// чтобы не подхватить `npm run dev` (5173, реальный бэк) или сервер соседнего worktree.
// E2E_PORT — переопределить порт.
const PORT = Number(process.env.E2E_PORT ?? 5174)
const URL = `http://localhost:${PORT}`

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  reporter: 'list',
  use: {
    baseURL: URL,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `npm run dev:mock -- --port ${PORT}`,
    url: URL,
    reuseExistingServer: true,
    timeout: 60_000,
  },
})
