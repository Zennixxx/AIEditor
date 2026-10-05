import { expect, test, type Page } from '@playwright/test'

// Раскладка таймлайна (src/timeline/geometry.ts): полоса секций 14 + линейка 28 = 42px, дальше V1 (64px), A1 (56px);
// дорожки свойств — по 18px под видеодорожкой.
const RULER_H = 42
const V1_CENTER_Y = RULER_H + 32
const LANE_H = 18

interface Store {
  getState(): Record<string, unknown> & {
    project: { tracks: { name: string; items: { id: string; start: number; duration: number }[] }[] }
  }
}

/** Импорт видео и бросок на V1 у начала таймлайна; возвращает start/duration клипа. */
async function videoClip(page: Page, name: string) {
  await page
    .getByTestId('media-import-input')
    .setInputFiles({ name, mimeType: 'video/mp4', buffer: Buffer.from('x') })
  await expect(page.getByTestId('asset-card').filter({ hasText: name })).toHaveAttribute(
    'data-status',
    'ready',
    {
      timeout: 10_000,
    },
  )
  const canvas = page.getByTestId('timeline').locator('canvas')
  await page
    .getByTestId('asset-card')
    .filter({ hasText: name })
    .dragTo(canvas, { targetPosition: { x: 4, y: V1_CENTER_Y } })
  await expect(page.getByTestId('timeline')).toHaveAttribute('data-clip-count', '1')
  return page.evaluate(() => {
    const w = window as unknown as { __aieditor: { useProject: Store } }
    const v1 = w.__aieditor.useProject.getState().project.tracks.find((t) => t.name === 'V1')!
    const c = v1.items[0]!
    return { start: c.start, duration: c.duration }
  })
}

async function setPlayhead(page: Page, t: number) {
  await page.evaluate((time) => {
    const w = window as unknown as { __aieditor: { useUi: { getState(): { setPlayhead(t: number): void } } } }
    w.__aieditor.useUi.getState().setPlayhead(time)
  }, t)
}

async function view(page: Page) {
  return page.evaluate(() => {
    const w = window as unknown as {
      __aieditor: { useUi: { getState(): { pxPerSec: number; scrollX: number } } }
    }
    const { pxPerSec, scrollX } = w.__aieditor.useUi.getState()
    return { pxPerSec, scrollX }
  })
}

test('keyframes: stopwatch, auto-key, ease preset, lane diamonds, delete + undo', async ({ page }) => {
  await page.goto('/')
  const clip = await videoClip(page, 'kf_clip.mp4')
  expect(clip.duration).toBeGreaterThan(1.5)
  const transform = page.getByTestId('clip-transform')
  await expect(transform).toBeVisible()
  const graph = page.getByTestId('key-graph')
  const scale = page.getByTestId('anim-value-scale')

  // секундомер: ключ в начале клипа
  await setPlayhead(page, clip.start)
  await page.getByTestId('anim-toggle-scale').click()
  await expect(page.getByTestId('anim-toggle-scale')).toHaveAttribute('aria-pressed', 'true')
  await expect(graph).toHaveAttribute('data-keys', '1')

  // автоключ: новое значение через 1 с
  await setPlayhead(page, clip.start + 1)
  await scale.fill('150')
  await expect(graph).toHaveAttribute('data-keys', '2')
  await setPlayhead(page, clip.start + 0.5)
  await expect(scale).toHaveValue('125')

  // интерполяция первого ключа: hold — значение держится до следующего ключа
  await setPlayhead(page, clip.start)
  await page.getByTestId('ease-hold').click()
  await setPlayhead(page, clip.start + 0.5)
  await expect(scale).toHaveValue('100')

  // дорожка свойства «масштаб» (Shift+S), выделение ключа кликом, Delete, undo
  await page
    .getByTestId('timeline')
    .locator('canvas')
    .click({ position: { x: 400, y: 10 } }) // фокус ухода с полей
  await page.keyboard.press('Shift+S')
  await expect(page.getByTestId('lane-header-V1-scale')).toBeVisible()
  const v = await view(page)
  const keyX = (clip.start + 1 - v.scrollX) * v.pxPerSec
  const laneY = RULER_H + 64 + LANE_H / 2
  const canvas = page.getByTestId('timeline').locator('canvas')
  await canvas.click({ position: { x: keyX, y: laneY } })
  await expect
    .poll(() =>
      page.evaluate(() => {
        const w = window as unknown as { __aieditor: { useUi: { getState(): { keySelection: unknown[] } } } }
        return w.__aieditor.useUi.getState().keySelection.length
      }),
    )
    .toBe(1)

  // перетаскивание ключа вправо на 0.25 с
  const box = (await canvas.boundingBox())!
  await page.mouse.move(box.x + keyX, box.y + laneY)
  await page.mouse.down()
  await page.mouse.move(box.x + keyX + v.pxPerSec * 0.25, box.y + laneY, { steps: 5 })
  await page.mouse.up()
  const times = await page.evaluate(() => {
    const w = window as unknown as {
      __aieditor: {
        useProject: { getState(): { project: { tracks: { items: { transform?: { scale: unknown } }[] }[] } } }
      }
    }
    const scaleKeys = w.__aieditor.useProject
      .getState()
      .project.tracks.flatMap((t) => t.items)
      .find((i) => i.transform)!.transform!.scale as { t: number }[]
    return scaleKeys.map((k) => k.t)
  })
  expect(times[0]).toBe(0)
  // время ключа квантуется к кадру (30 fps)
  expect(Math.abs(times[1]! - 1.25)).toBeLessThanOrEqual(1 / 30 + 1e-6)

  await page.keyboard.press('Delete')
  await expect(graph).toHaveAttribute('data-keys', '1')
  await page.keyboard.press('Control+Z')
  await expect(graph).toHaveAttribute('data-keys', '2')
})

test('transitions: drop on a cut → "Переходы" fx track, ⇄ on all cuts, undo', async ({ page }) => {
  const errors: string[] = []
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text())
  })
  await page.goto('/')
  const timeline = page.getByTestId('timeline')
  const canvas = timeline.locator('canvas')
  const clip = await videoClip(page, 'tr_clip.mp4')

  // разрезать посередине → один стык
  const cut = clip.start + Math.round((clip.duration / 2) * 30) / 30
  await setPlayhead(page, cut)
  await page.keyboard.press('Control+K')
  await expect(timeline).toHaveAttribute('data-clip-count', '2')

  const v = await view(page)
  const cutX = (cut - v.scrollX) * v.pxPerSec
  // бросок чуть мимо стыка — переход «прилипает» к нему
  await page
    .getByTestId('effect-card-whipPan')
    .dragTo(canvas, { targetPosition: { x: cutX + 15, y: V1_CENTER_Y } })
  await expect(timeline).toHaveAttribute('data-effect-count', '1')
  await expect(page.getByTestId('track-header-Переходы')).toBeVisible()
  const item = await page.evaluate(() => {
    const w = window as unknown as { __aieditor: { useProject: Store } }
    const t = w.__aieditor.useProject.getState().project.tracks.find((x) => x.name === 'Переходы')!
    return t.items[0]!
  })
  expect(item.start + item.duration / 2).toBeCloseTo(cut, 4)

  // превью рендерит переход на стыке
  await setPlayhead(page, cut - 0.05)
  await expect(page.getByTestId('preview-canvas')).toHaveAttribute('data-effects', /[1-9]/)

  await page.keyboard.press('Control+Z')
  await expect(timeline).toHaveAttribute('data-effect-count', '0')

  // ⇄ у карточки перехода: на все стыки
  await page.keyboard.press('Escape')
  await page.getByTestId('effect-to-cuts-flashTransition').click()
  await expect(timeline).toHaveAttribute('data-effect-count', '1')
  expect(errors.filter((e) => /Шейдер/.test(e))).toEqual([])
})

test('presets: apply a combo to a clip, save the selection as a new preset', async ({ page }) => {
  await page.goto('/')
  const timeline = page.getByTestId('timeline')
  const canvas = timeline.locator('canvas')
  const card = page.getByTestId('preset-card-pst_hitcombo01')
  await expect(card).toBeVisible()
  await videoClip(page, 'pst_clip.mp4')

  await card.dragTo(canvas, { targetPosition: { x: 60, y: V1_CENTER_Y } })
  await expect(timeline).toHaveAttribute('data-effect-count', '3')
  await expect(page.getByTestId('clip-fx-shake')).toBeVisible()
  await expect(page.getByTestId('clip-fx-rgbSplit')).toBeVisible()

  // выделен клип с эффектами — сохранить пресет
  await page.getByTestId('preset-save-open').click()
  await page.getByTestId('preset-name').fill('Мой удар')
  await page.getByTestId('preset-save').click()
  await expect(page.getByTestId('presets').getByText('Мой удар')).toBeVisible()
  await expect(page.getByTestId('preset-name')).toHaveCount(0)
})
