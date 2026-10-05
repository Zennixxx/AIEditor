import { expect, test } from '@playwright/test'

// Раскладка таймлайна (src/timeline/geometry.ts): линейка 28px, новый проект — V1 (64px), A1 (56px).
const RULER_H = 42
const V1_CENTER_Y = RULER_H + 32

test('import → drag asset to timeline → Ctrl+K splits → Ctrl+Z undoes', async ({ page }) => {
  await page.goto('/')

  // импорт (MSW: POST /assets/upload → цепочка proxy/thumbs/audio/waveform, CONTRACT §8.1)
  await page.getByTestId('media-import-input').setInputFiles({
    name: 'e2e_clip.mp4',
    mimeType: 'video/mp4',
    buffer: Buffer.from('not really a video'),
  })
  const card = page.getByTestId('asset-card').filter({ hasText: 'e2e_clip.mp4' })
  await expect(card).toBeVisible()
  // пока идут задачи производных файлов — ассет `importing`, прогресс виден на карточке
  await expect(card).toHaveAttribute('data-status', 'importing')
  await expect(card.getByTestId('asset-job').first()).toBeVisible()
  // готовность — WS-событие asset со status "ready" после всей цепочки
  await expect(card).toHaveAttribute('data-status', 'ready', { timeout: 10_000 })

  const timeline = page.getByTestId('timeline')
  const canvas = timeline.locator('canvas')
  await expect(timeline).toHaveAttribute('data-clip-count', '0')

  // перетаскивание на дорожку V1 (x=40px ≈ 1 с при зуме по умолчанию 40 px/с)
  await card.dragTo(canvas, { targetPosition: { x: 40, y: V1_CENTER_Y } })
  await expect(timeline).toHaveAttribute('data-clip-count', '1')

  // плейхед кликом по линейке внутрь клипа (5 с), затем Ctrl+K
  await canvas.click({ position: { x: 200, y: 10 } })
  await expect(page.getByTestId('playhead-timecode')).toHaveText('00:05:00')
  await page.keyboard.press('Control+K')
  await expect(timeline).toHaveAttribute('data-clip-count', '2')

  await page.keyboard.press('Control+Z')
  await expect(timeline).toHaveAttribute('data-clip-count', '1')

  // redo возвращает разрез, ещё два undo — пустой таймлайн
  await page.keyboard.press('Control+Shift+Z')
  await expect(timeline).toHaveAttribute('data-clip-count', '2')
  await page.keyboard.press('Control+Z')
  await page.keyboard.press('Control+Z')
  await expect(timeline).toHaveAttribute('data-clip-count', '0')
})

test('clip can be selected, moved by drag and deleted', async ({ page }) => {
  await page.goto('/')
  await page.getByTestId('media-import-input').setInputFiles({
    name: 'move_me.mp4',
    mimeType: 'video/mp4',
    buffer: Buffer.from('x'),
  })
  const card = page.getByTestId('asset-card').filter({ hasText: 'move_me.mp4' })
  await expect(card).toHaveAttribute('data-status', 'ready')
  const timeline = page.getByTestId('timeline')
  const canvas = timeline.locator('canvas')
  await card.dragTo(canvas, { targetPosition: { x: 40, y: V1_CENTER_Y } })
  await expect(timeline).toHaveAttribute('data-clip-count', '1')
  await expect(timeline).toHaveAttribute('data-selection-count', '1')

  // клик по пустому месту снимает выделение, клик по клипу выделяет
  await canvas.click({ position: { x: 600, y: V1_CENTER_Y } })
  await expect(timeline).toHaveAttribute('data-selection-count', '0')
  await canvas.click({ position: { x: 120, y: V1_CENTER_Y } })
  await expect(timeline).toHaveAttribute('data-selection-count', '1')

  // перетаскивание клипа вправо: плейхед не меняется, клип остаётся один
  const box = (await canvas.boundingBox())!
  await page.mouse.move(box.x + 120, box.y + V1_CENTER_Y)
  await page.mouse.down()
  await page.mouse.move(box.x + 220, box.y + V1_CENTER_Y, { steps: 5 })
  await page.mouse.up()
  await expect(timeline).toHaveAttribute('data-clip-count', '1')

  await page.keyboard.press('Delete')
  await expect(timeline).toHaveAttribute('data-clip-count', '0')
  await page.keyboard.press('Control+Z')
  await expect(timeline).toHaveAttribute('data-clip-count', '1')
})
