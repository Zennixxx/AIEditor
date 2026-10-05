import { expect, test } from '@playwright/test'

// Раскладка таймлайна (src/timeline/geometry.ts): полоса секций 14 + линейка 28 = 42px, дальше V1 (64px), A1 (56px).
const RULER_H = 42
const V1_CENTER_Y = RULER_H + 32
const A1_CENTER_Y = RULER_H + 64 + 28

test('cut to markers: dialog → slots on bass markers → undo/redo', async ({ page }) => {
  await page.goto('/')
  const timeline = page.getByTestId('timeline')
  const canvas = timeline.locator('canvas')

  // видео и музыка
  for (const [name, mimeType] of [
    ['cut_clip.mp4', 'video/mp4'],
    ['cut_track.mp3', 'audio/mpeg'],
  ] as const) {
    await page.getByTestId('media-import-input').setInputFiles({ name, mimeType, buffer: Buffer.from('x') })
    await expect(page.getByTestId('asset-card').filter({ hasText: name })).toHaveAttribute(
      'data-status',
      'ready',
      { timeout: 10_000 },
    )
  }
  await page
    .getByTestId('asset-card')
    .filter({ hasText: 'cut_clip.mp4' })
    .dragTo(canvas, { targetPosition: { x: 40, y: V1_CENTER_Y } })
  await expect(timeline).toHaveAttribute('data-clip-count', '1')
  await page
    .getByTestId('asset-card')
    .filter({ hasText: 'cut_track.mp3' })
    .dragTo(canvas, { targetPosition: { x: 40, y: A1_CENTER_Y } })
  await expect(timeline).toHaveAttribute('data-clip-count', '2')
  await expect(page.getByTestId('analysis-bpm')).toContainText('BPM', { timeout: 15_000 })

  // диалог: выбираем видеоклип, каждый 4-й bass → слоты
  await page.getByTestId('cut-open').click()
  const dialog = page.getByTestId('cut-dialog')
  await expect(dialog).toBeVisible()
  const preview = page.getByTestId('cut-preview')
  await expect(preview).toContainText('Слотов')
  const all = Number(await preview.getAttribute('data-slots'))
  expect(all).toBeGreaterThan(8)

  await page.getByTestId('cut-every').fill('4')
  await expect.poll(async () => Number(await preview.getAttribute('data-slots'))).toBeLessThan(all)
  const slots = Number(await preview.getAttribute('data-slots'))
  expect(slots).toBeGreaterThan(2)

  // пустой набор видов маркеров — нарезка невозможна
  await page.getByTestId('cut-kind-bass').click()
  await expect(page.getByTestId('cut-apply')).toBeDisabled()
  await page.getByTestId('cut-kind-bass').click()
  await expect(page.getByTestId('cut-apply')).toBeEnabled()

  await page.getByTestId('cut-apply').click()
  await expect(dialog).toHaveCount(0)
  // исходный клип заменён слотами, музыкальный клип на месте
  await expect(timeline).toHaveAttribute('data-clip-count', String(slots + 1))
  await expect(timeline).toHaveAttribute('data-selection-count', String(slots))

  // одна запись истории
  await page.keyboard.press('Control+Z')
  await expect(timeline).toHaveAttribute('data-clip-count', '2')
  await page.keyboard.press('Control+Shift+Z')
  await expect(timeline).toHaveAttribute('data-clip-count', String(slots + 1))

  // слоты стыкуются без пробелов — «сомкнуть пробелы» неактивна; диалог закрывается по Escape
  await expect(page.getByTestId('ripple-V1')).toBeDisabled()
  await page.getByTestId('cut-open').click()
  await expect(page.getByTestId('cut-dialog')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('cut-dialog')).toHaveCount(0)
})
