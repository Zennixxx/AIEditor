import { expect, test } from '@playwright/test'

// Раскладка таймлайна (src/timeline/geometry.ts): полоса секций 14 + линейка 28 = 42px, дальше V1 (64px), A1 (56px).
const RULER_H = 42
const A1_CENTER_Y = RULER_H + 64 + 28

test('audio clip → analysis → markers visible → threshold hides weak → M adds → Delete removes → Ctrl+Z', async ({
  page,
}) => {
  await page.goto('/')

  // музыка: импорт (MSW) → готов → на дорожку A1
  await page.getByTestId('media-import-input').setInputFiles({
    name: 'e2e_track.mp3',
    mimeType: 'audio/mpeg',
    buffer: Buffer.from('not really audio'),
  })
  const card = page.getByTestId('asset-card').filter({ hasText: 'e2e_track.mp3' })
  await expect(card).toHaveAttribute('data-status', 'ready', { timeout: 10_000 })
  const timeline = page.getByTestId('timeline')
  const canvas = timeline.locator('canvas')
  await card.dragTo(canvas, { targetPosition: { x: 40, y: A1_CENTER_Y } })
  await expect(timeline).toHaveAttribute('data-clip-count', '1')
  await expect(timeline).toHaveAttribute('data-selection-count', '1')

  // анализ стартует сам (задача musicAnalysis с прогрессом по WS), панель анализа — в инспекторе клипа
  const panel = page.getByTestId('analysis-panel')
  await expect(panel).toBeVisible()
  await expect(page.getByTestId('analyze-button')).toHaveText('Анализ…')
  await expect(page.getByTestId('analysis-progress')).toBeVisible()
  await expect(page.getByTestId('analysis-bpm')).toContainText('BPM', { timeout: 15_000 })
  await expect(page.getByTestId('analyze-button')).toHaveText('Переанализировать')
  await expect(page.getByTestId('analysis-counts')).toContainText('авто')

  // маркеры видны: фильтр показывает bass/beat/downbeat (onset скрыт по умолчанию)
  const count = page.getByTestId('marker-count')
  await expect(count).not.toHaveText('0')
  const total = Number(await count.textContent())
  expect(total).toBeGreaterThan(100)

  // порог силы скрывает слабые
  await page.getByTestId('marker-threshold').fill('0.7')
  await expect.poll(async () => Number(await count.textContent())).toBeLessThan(total)
  const filtered = Number(await count.textContent())
  await page.getByTestId('marker-threshold').fill('0')
  await expect(count).toHaveText(String(total))

  // чекбокс вида: onset показывает больше
  await page.getByTestId('marker-kind-onset').click()
  await expect.poll(async () => Number(await count.textContent())).toBeGreaterThan(total)
  await page.getByTestId('marker-kind-onset').click()
  await expect(count).toHaveText(String(total))
  expect(filtered).toBeLessThan(total)

  // плейхед внутрь клипа, M — ручной маркер на выделенный аудиоклип (+1 к видимым)
  await canvas.click({ position: { x: 300, y: 10 } })
  await page.keyboard.press('KeyM')
  await expect(count).toHaveText(String(total + 1))
  await expect(page.getByTestId('marker-editor')).toBeVisible() // новый маркер выделен

  // Delete удаляет выделенный маркер (а не клип), Ctrl+Z возвращает
  await page.keyboard.press('Delete')
  await expect(count).toHaveText(String(total))
  await expect(timeline).toHaveAttribute('data-clip-count', '1')
  await page.keyboard.press('Control+Z')
  await expect(count).toHaveText(String(total + 1))
})

test('Shift+arrows jump between markers and project markers go on the ruler', async ({ page }) => {
  await page.goto('/')
  const timeline = page.getByTestId('timeline')
  const canvas = timeline.locator('canvas')
  const count = page.getByTestId('marker-count')
  // без выделенного аудиоклипа M ставит маркер проекта на линейку
  await canvas.click({ position: { x: 120, y: 10 } }) // 3 с
  await page.keyboard.press('KeyM')
  await canvas.click({ position: { x: 280, y: 10 } }) // 7 с
  await page.keyboard.press('KeyM')
  await expect(count).toHaveText('2')
  await page.keyboard.press('Home')
  await page.keyboard.press('Shift+ArrowRight')
  await expect(page.getByTestId('playhead-timecode')).toHaveText('00:03:00')
  await page.keyboard.press('Shift+ArrowRight')
  await expect(page.getByTestId('playhead-timecode')).toHaveText('00:07:00')
  await page.keyboard.press('Shift+ArrowLeft')
  await expect(page.getByTestId('playhead-timecode')).toHaveText('00:03:00')
})

test('marker on the ruler: drag with frame snap, double click edits the label, Alt-box selects', async ({
  page,
}) => {
  await page.goto('/')
  const canvas = page.getByTestId('timeline').locator('canvas')
  const box = (await canvas.boundingBox())!
  await canvas.click({ position: { x: 120, y: 10 } }) // 3 с
  await page.keyboard.press('KeyM')
  await expect(page.getByTestId('marker-count')).toHaveText('1')

  // drag по треугольнику на линейке: 3 с → 5 с
  await page.mouse.move(box.x + 120, box.y + 35)
  await page.mouse.down()
  await page.mouse.move(box.x + 200, box.y + 35, { steps: 6 })
  await page.mouse.up()
  await page.keyboard.press('Home')
  await page.keyboard.press('Shift+ArrowRight')
  await expect(page.getByTestId('playhead-timecode')).toHaveText('00:05:00')

  // двойной клик: поле подписи в инспекторе в фокусе
  await canvas.dblclick({ position: { x: 200, y: 35 } })
  const label = page.getByTestId('marker-label-input')
  await expect(label).toBeFocused()
  await label.fill('DROP')
  await label.press('Enter')
  await expect(label).toHaveValue('DROP')

  // Alt + рамка по линейке выделяет маркер; Escape снимает
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('marker-editor')).toHaveCount(0)
  await page.mouse.move(box.x + 170, box.y + 20)
  await page.keyboard.down('Alt')
  await page.mouse.down()
  await page.mouse.move(box.x + 230, box.y + 40, { steps: 4 })
  await page.mouse.up()
  await page.keyboard.up('Alt')
  await expect(page.getByTestId('marker-editor')).toBeVisible()
  await expect(page.getByTestId('marker-label-input')).toHaveValue('DROP')
})
