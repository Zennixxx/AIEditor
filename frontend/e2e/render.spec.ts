import { expect, test } from '@playwright/test'

test('preview renders through WebGL2 with effects and compiles every shader', async ({ page }) => {
  const errors: string[] = []
  page.on('console', (msg) => {
    if (msg.type() === 'error' || msg.type() === 'warning') errors.push(msg.text())
  })
  page.on('pageerror', (e) => errors.push(e.message))

  await page.goto('/')
  await page.getByRole('button', { name: 'Демо-проект' }).click()
  const preview = page.getByTestId('preview-canvas')
  await expect(preview).toHaveAttribute('data-renderer', 'webgl2')
  await expect(preview).toHaveAttribute('data-source', 'video', { timeout: 30_000 })
  // filmGrain на fx-дорожке активен на всём проекте
  await expect(preview).toHaveAttribute('data-effects', /[1-9]/)
  expect(errors.filter((e) => /Шейдер|WebGL2 недоступен/.test(e))).toEqual([])
})
