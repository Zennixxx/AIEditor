import { expect, test, type Page } from '@playwright/test'

interface Store {
  getState(): {
    project: { tracks: { kind: string; name: string; items: unknown[] }[] }
    history: { past: unknown[] }
    undo(): boolean
  }
}

const tracks = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { __aieditor: { useProject: Store } }
    return w.__aieditor.useProject.getState().project.tracks.map((t) => t.name)
  })

async function openDemo(page: Page) {
  await page.goto('/')
  await page.getByRole('button', { name: 'Демо-проект' }).click()
  await expect(page.getByTestId('project-name')).toHaveValue('Demo phonk edit')
}

test('copilot: command → preview on the timeline → apply → undo', async ({ page }) => {
  await openDemo(page)
  const before = await tracks(page)

  await page.getByTestId('ai-input').fill('шейк на сильные басы в дропе')
  await page.getByTestId('ai-input').press('Enter')
  const preview = page.getByTestId('ai-preview')
  await expect(preview).toBeVisible({ timeout: 10_000 })
  await expect(preview).toContainText('Новая fx-дорожка «AI: шейк»')
  await expect(preview).toContainText('«Шейк» на маркеры')
  await expect(page.getByTestId('timeline')).toHaveAttribute('data-ai-preview', 'on')
  await expect(page.getByTestId('track-header-AI: шейк')).toBeVisible()
  expect(await tracks(page)).toEqual(before)

  await page.getByTestId('ai-apply').click()
  await expect(preview).toBeHidden()
  await expect(page.getByTestId('timeline')).not.toHaveAttribute('data-ai-preview', 'on')
  await expect(page.getByTestId('ai-message').last()).toHaveAttribute('data-status', 'applied')
  expect(await tracks(page)).toContain('AI: шейк')

  await page.evaluate(() => {
    const w = window as unknown as { __aieditor: { useProject: Store } }
    w.__aieditor.useProject.getState().undo()
  })
  expect(await tracks(page)).toEqual(before)
})

test('copilot: quick chip and reject keep the project unchanged', async ({ page }) => {
  await openDemo(page)
  const before = await tracks(page)
  await page.getByRole('button', { name: 'Velocity в конце' }).click()
  await expect(page.getByTestId('ai-preview')).toBeVisible({ timeout: 10_000 })
  await page.getByTestId('ai-reject').click()
  await expect(page.getByTestId('ai-preview')).toBeHidden()
  await expect(page.getByTestId('ai-message').last()).toHaveAttribute('data-status', 'rejected')
  expect(await tracks(page)).toEqual(before)
})

test('auto-edit wizard: four steps → job progress → preview → apply', async ({ page }) => {
  await openDemo(page)
  await page.getByTestId('open-auto-edit').click()
  const wizard = page.getByTestId('auto-edit-wizard')
  await expect(wizard).toBeVisible()
  await expect(page.getByTestId('ae-music')).toContainText('маркеров')
  await page.getByTestId('ae-next').click()
  await expect(wizard.locator('input[type="checkbox"]:checked')).not.toHaveCount(0)
  await page.getByTestId('ae-next').click()
  await page.getByTestId('ae-style-amv').click()
  await expect(page.getByTestId('ae-style-amv')).toHaveAttribute('aria-pressed', 'true')
  await page.getByTestId('ae-reference').click()
  await expect(wizard.locator('[data-testid^="ae-style-ref_"]')).toHaveAttribute('aria-pressed', 'true', {
    timeout: 10_000,
  })
  await page.getByTestId('ae-next').click()
  await page.getByTestId('ae-intensity').fill('0.5')
  await page.getByTestId('ae-run').click()
  await expect(page.getByTestId('ae-progress')).toBeVisible()
  await expect(wizard).toBeHidden({ timeout: 15_000 })
  const preview = page.getByTestId('ai-preview')
  await expect(preview).toContainText('Автоэдит «Стиль:')
  await page.getByTestId('ai-apply').click()
  expect(await tracks(page)).toContain('AI: шейк')
})

test('media bin: AI clip analysis button shows the number of moments', async ({ page }) => {
  await openDemo(page)
  const card = page.locator('[data-testid="asset-card"][data-asset-id="ast_8a7e5d4c3b2a1908"]')
  const button = card.getByTestId('asset-ai-analyze')
  await expect(button).toHaveText('Проанализировать ИИ')
  await button.click()
  await expect(button).toHaveText(/ИИ ✓ \d+/, { timeout: 15_000 })
})
