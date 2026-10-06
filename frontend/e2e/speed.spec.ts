import { expect, test, type Page } from '@playwright/test'

const RULER_H = 42
const V1_CENTER_Y = RULER_H + 32
const V1_STRIP_Y = RULER_H + 64 - 5

interface RampKey {
  u: number
  speed: number
}

interface ClipState {
  id: string
  start: number
  duration: number
  interpolatedAssetId?: string
  timeRemap?: { keyframes: RampKey[]; fit: string; frameBlend: boolean }
}

async function videoClip(page: Page, name: string): Promise<ClipState> {
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
  return clipState(page)
}

function clipState(page: Page): Promise<ClipState> {
  return page.evaluate(() => {
    const w = window as unknown as {
      __aieditor: {
        useProject: { getState(): { project: { tracks: { name: string; items: ClipState[] }[] } } }
      }
    }
    const v1 = w.__aieditor.useProject.getState().project.tracks.find((t) => t.name === 'V1')!
    return structuredClone(v1.items[0]!)
  })
}

async function setPlayhead(page: Page, t: number) {
  await page.evaluate((time) => {
    const w = window as unknown as { __aieditor: { useUi: { getState(): { setPlayhead(t: number): void } } } }
    w.__aieditor.useUi.getState().setPlayhead(time)
  }, t)
}

async function clipX(page: Page, t: number): Promise<number> {
  return page.evaluate((time) => {
    const w = window as unknown as {
      __aieditor: { useUi: { getState(): { pxPerSec: number; scrollX: number } } }
    }
    const { pxPerSec, scrollX } = w.__aieditor.useUi.getState()
    return (time - scrollX) * pxPerSec
  }, t)
}

test('speed ramp: preset, frame blending until interpolation is ready, graph editor, undo', async ({
  page,
}) => {
  await page.goto('/')
  const clip = await videoClip(page, 'ramp_clip.mp4')
  const speed = page.getByTestId('clip-speed')
  await expect(speed).toBeVisible()
  const status = page.getByTestId('interp-status')
  await expect(status).toHaveAttribute('data-state', 'none')

  await page.getByTestId('ramp-preset').selectOption('fast-slow-fast')
  await page.getByTestId('ramp-apply').click()
  await expect(page.getByTestId('speed-mode-curve')).toHaveAttribute('aria-pressed', 'true')
  const ramped = await clipState(page)
  expect(ramped.timeRemap?.keyframes.map((k) => k.speed)).toEqual([3, 0.25, 0.25, 3])
  await expect(status).not.toHaveAttribute('data-state', 'none')

  const preview = page.getByTestId('preview-canvas')
  let blended = false
  for (const offset of [0, 0.011, 0.023, 0.037]) {
    await setPlayhead(page, clip.start + clip.duration * 0.5 + offset)
    try {
      await expect(preview).toHaveAttribute('data-blended', '1', { timeout: 1500 })
      blended = true
      break
    } catch {
      continue
    }
  }
  expect(blended).toBe(true)

  await expect(status).toHaveAttribute('data-state', 'ready', { timeout: 12_000 })
  await expect(status).toContainText('RIFE')
  const ready = await clipState(page)
  expect(ready.interpolatedAssetId).toMatch(/^ast_/)
  await expect(preview).toHaveAttribute('data-blended', '0', { timeout: 3000 })
  await expect(page.getByTestId('asset-card').filter({ hasText: '×' })).toHaveCount(0)

  await page.keyboard.press('Shift+F3')
  const editor = page.getByTestId('curve-editor')
  await expect(editor).toBeVisible()
  const plot = page.getByTestId('curve-plot')
  await expect(plot).toHaveAttribute('data-keys', '4')

  const key = page.getByTestId('curve-key-1')
  const box = (await key.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + 10, box.y + box.height / 2 - 30, { steps: 5 })
  await page.mouse.move(box.x + box.width / 2 + 20, box.y + box.height / 2 - 40, { steps: 5 })
  await page.mouse.up()
  const dragged = await clipState(page)
  expect(dragged.timeRemap!.keyframes[1]!.speed).toBeGreaterThan(0.3)
  expect(dragged.timeRemap!.keyframes[1]!.u).toBeGreaterThan(0.35)

  await page.keyboard.press('Control+z')
  const undone = await clipState(page)
  expect(undone.timeRemap!.keyframes[1]).toMatchObject({ u: 0.35, speed: 0.25 })

  const plotBox = (await plot.boundingBox())!
  await page.mouse.dblclick(plotBox.x + plotBox.width * 0.85, plotBox.y + 20)
  await expect(plot).toHaveAttribute('data-keys', '5')
  await page.getByTestId('curve-ease-easeInOut').click()
  await expect(page.getByTestId('curve-handle-1')).toBeVisible()
  await page.keyboard.press('Delete')
  await expect(plot).toHaveAttribute('data-keys', '4')
  await expect(page.getByTestId('timeline')).toHaveAttribute('data-clip-count', '1')

  await page.getByTestId('curve-close').click()
  await expect(editor).toHaveCount(0)

  const canvas = page.getByTestId('timeline').locator('canvas')
  const canvasBox = (await canvas.boundingBox())!
  const x = await clipX(page, clip.start + clip.duration / 2)
  await page.mouse.dblclick(canvasBox.x + x, canvasBox.y + V1_STRIP_Y)
  await expect(editor).toBeVisible()
  await page.keyboard.press('Shift+F3')
  await expect(editor).toHaveCount(0)

  await page.getByTestId('ramp-velocity').click()
  await expect(page.getByTestId('speed-message')).toContainText('нет подходящих маркеров')

  await page.getByTestId('speed-mode-constant').click()
  const constant = await clipState(page)
  expect(constant.timeRemap).toBeUndefined()
  await expect(status).toHaveAttribute('data-state', 'none', { timeout: 5000 })
})
