import { expect, test } from '@playwright/test'

test('layout renders and mock backend is connected', async ({ page }) => {
  await page.goto('/')
  for (const name of ['Медиа', 'Превью', 'Инспектор', 'Таймлайн']) {
    await expect(page.getByRole('region', { name })).toBeVisible()
  }
  const status = page.getByTestId('backend-status')
  await expect(status).toContainText('MOCK')
  await expect(status).toHaveAttribute('data-level', 'ok')
})

test('split panes resize and persist', async ({ page }) => {
  await page.goto('/')
  const media = page.getByRole('region', { name: 'Медиа' })
  const before = (await media.boundingBox())!.width
  // первый вертикальный разделитель в DOM — между левой колонкой («Медиа» / «Эффекты») и «Превью»
  const handle = page.locator('[role="separator"][aria-orientation="vertical"]').first()
  const box = (await handle.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + 120, box.y + box.height / 2, { steps: 5 })
  await page.mouse.up()
  const after = (await media.boundingBox())!.width
  expect(after).toBeGreaterThan(before + 80)

  await page.reload()
  const reloaded = (await page.getByRole('region', { name: 'Медиа' }).boundingBox())!.width
  expect(Math.abs(reloaded - after)).toBeLessThan(4)
})
