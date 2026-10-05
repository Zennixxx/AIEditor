import { expect, test, type Page } from '@playwright/test'

/** Таймкод `mm:ss:ff` → секунды (fps демо-проекта — 30). */
function seconds(tc: string, fps = 30): number {
  const [m, s, f] = tc.split(':').map(Number)
  return (m ?? 0) * 60 + (s ?? 0) + (f ?? 0) / fps
}

async function playhead(page: Page): Promise<number> {
  return seconds((await page.getByTestId('playhead-timecode').textContent()) ?? '')
}

test('Space plays (playhead moves), Space pauses, Home returns to 0', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Демо-проект' }).click()
  const timeline = page.getByTestId('timeline')
  await expect(timeline).toHaveAttribute('data-clip-count', '6')

  // на паузе превью показывает кадр из proxy.mp4 (MSW генерирует проигрываемый ролик)
  const preview = page.getByTestId('preview-canvas')
  await expect(preview).toHaveAttribute('data-source', 'video', { timeout: 30_000 })
  await expect(preview).toHaveAttribute('data-clip-id', 'clp_intro00001')
  await expect(page.getByTestId('playhead-timecode')).toHaveText('00:00:00')

  // Space — воспроизведение: плейхед движется
  await page.keyboard.press('Space')
  const play = page.getByTestId('transport-play')
  await expect(play).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(() => playhead(page), { timeout: 5_000 }).toBeGreaterThan(0.5)
  const t1 = await playhead(page)
  await expect.poll(() => playhead(page), { timeout: 5_000 }).toBeGreaterThan(t1 + 0.3)
  // во время воспроизведения кадр идёт из видео
  await expect(preview).toHaveAttribute('data-source', 'video')

  // повторный Space — пауза: плейхед стоит
  await page.keyboard.press('Space')
  await expect(play).toHaveAttribute('aria-pressed', 'false')
  const stopped = await page.getByTestId('playhead-timecode').textContent()
  await page.waitForTimeout(600)
  await expect(page.getByTestId('playhead-timecode')).toHaveText(stopped ?? '')
  expect(seconds(stopped ?? '')).toBeGreaterThan(0.5)

  // Home — в начало
  await page.keyboard.press('Home')
  await expect(page.getByTestId('playhead-timecode')).toHaveText('00:00:00')
  await expect(page.getByTestId('preview-timecode')).toHaveText('00:00:00')
})

test('arrow keys step by one frame, End jumps to the end of the project', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Демо-проект' }).click()
  await expect(page.getByTestId('timeline')).toHaveAttribute('data-clip-count', '6')
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight')
  await expect(page.getByTestId('playhead-timecode')).toHaveText('00:00:02')
  await page.keyboard.press('ArrowLeft')
  await expect(page.getByTestId('playhead-timecode')).toHaveText('00:00:01')
  await page.keyboard.press('End')
  await expect(page.getByTestId('playhead-timecode')).toHaveText('01:36:00')
})
