import { expect, test } from '@playwright/test'

// Раскладка таймлайна (src/timeline/geometry.ts): полоса секций 14 + линейка 28 = 42px, дальше V1 (64px), A1 (56px).
const RULER_H = 42
const V1_CENTER_Y = RULER_H + 32
const A1_CENTER_Y = RULER_H + 64 + 28

test('effects: shake on every bass via dialog, drag onto a clip, inspector params, undo', async ({
  page,
}) => {
  await page.goto('/')
  const timeline = page.getByTestId('timeline')
  const canvas = timeline.locator('canvas')

  for (const [name, mimeType] of [
    ['fx_clip.mp4', 'video/mp4'],
    ['fx_track.mp3', 'audio/mpeg'],
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
    .filter({ hasText: 'fx_clip.mp4' })
    .dragTo(canvas, { targetPosition: { x: 40, y: V1_CENTER_Y } })
  await page
    .getByTestId('asset-card')
    .filter({ hasText: 'fx_track.mp3' })
    .dragTo(canvas, { targetPosition: { x: 40, y: A1_CENTER_Y } })
  await expect(timeline).toHaveAttribute('data-clip-count', '2')
  await expect(page.getByTestId('analysis-bpm')).toContainText('BPM', { timeout: 15_000 })
  await expect(timeline).toHaveAttribute('data-effect-count', '0')

  // ⚡ у карточки «Шейк» открывает диалог с этим эффектом
  await page.getByTestId('effect-to-markers-shake').click()
  const dialog = page.getByTestId('fx-dialog')
  await expect(dialog).toBeVisible()
  await expect(page.getByTestId('fx-effect')).toHaveValue('shake')
  const preview = page.getByTestId('fx-preview')
  await expect(preview).toContainText('Эффектов')
  const all = Number(await preview.getAttribute('data-count'))
  expect(all).toBeGreaterThan(4)
  await page.getByTestId('fx-every').fill('2')
  await expect.poll(async () => Number(await preview.getAttribute('data-count'))).toBeLessThan(all)
  const count = Number(await preview.getAttribute('data-count'))
  await page.getByTestId('fx-apply').click()
  await expect(dialog).toHaveCount(0)
  await expect(timeline).toHaveAttribute('data-effect-count', String(count))
  // новые эффекты выделены — в инспекторе редактор (выделено несколько — редактор не показывается)
  await expect(timeline).toHaveAttribute('data-selection-count', String(count))

  // превью рендерит эффекты под маркерами (WebGL2)
  const canvasPreview = page.getByTestId('preview-canvas')
  await expect(canvasPreview).toHaveAttribute('data-renderer', 'webgl2')

  // одна запись истории
  await page.keyboard.press('Control+Z')
  await expect(timeline).toHaveAttribute('data-effect-count', '0')
  await page.keyboard.press('Control+Shift+Z')
  await expect(timeline).toHaveAttribute('data-effect-count', String(count))

  // drag «Зум-панч» на видеоклип → эффект клипа, раскрыт в инспекторе
  await page
    .getByTestId('effect-card-zoomPunch')
    .dragTo(canvas, { targetPosition: { x: 60, y: V1_CENTER_Y } })
  await expect(timeline).toHaveAttribute('data-effect-count', String(count + 1))
  const editor = page.getByTestId('effect-editor')
  await expect(editor).toHaveAttribute('data-effect', 'zoomPunch')
  await expect(page.getByTestId('clip-fx-zoomPunch')).toBeVisible()

  // параметр по реестру: amount 1..3
  const amount = page.getByTestId('fx-param-amount')
  await amount.fill('2')
  await expect(amount).toHaveValue('2')
  await page.getByTestId('fx-enabled').uncheck()
  await expect(page.getByTestId('fx-enabled')).not.toBeChecked()
  await page.getByTestId('fx-remove').click()
  await expect(timeline).toHaveAttribute('data-effect-count', String(count))
})
