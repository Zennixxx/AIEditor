import { expect, test, type Page } from '@playwright/test'

const WIDTH = 1280
const HEIGHT = 720
const IN = 30
const OUT = 31
const FPS = 30
const ALIGNED_FRAMES = [0, 2, 6, 8, 12, 16, 18, 22, 26, 28]
const BITRATE = 100

async function setPlayhead(page: Page, t: number): Promise<void> {
  await page.evaluate((time) => {
    const w = window as unknown as { __aieditor: { useUi: { getState(): { setPlayhead(t: number): void } } } }
    w.__aieditor.useUi.getState().setPlayhead(time)
  }, t)
}

test('export to MP4 matches the preview frame by frame', async ({ page }) => {
  test.setTimeout(240_000)
  await page.addInitScript(() => {
    Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true })
  })
  await page.goto('/')
  await page.getByRole('button', { name: 'Демо-проект' }).click()
  const preview = page.getByTestId('preview-canvas')
  await expect(preview).toHaveAttribute('data-source', 'video', { timeout: 30_000 })

  await setPlayhead(page, IN)
  await page.locator('body').press('i')
  await setPlayhead(page, OUT)
  await page.locator('body').press('o')

  await page.getByTestId('open-export').click()
  const dialog = page.getByTestId('export-dialog')
  await expect(dialog).toBeVisible()
  await expect(page.getByTestId('export-range-inout')).toBeChecked()
  await expect(page.getByTestId('export-range')).toContainText('30 кадров')
  await page.getByTestId('export-resolution').selectOption('720p')
  await expect(page.getByTestId('export-size')).toContainText(`${WIDTH}×${HEIGHT}`)
  await page.getByTestId('export-bitrate').fill(String(BITRATE))
  await expect(page.getByTestId('export-start')).toBeEnabled({ timeout: 30_000 })
  const vp9 = page.locator('[data-testid="export-codec"] option[value="vp9"]')
  if (!(await vp9.isDisabled())) await page.getByTestId('export-codec').selectOption('vp9')

  const download = page.waitForEvent('download', { timeout: 180_000 })
  await page.getByTestId('export-start').click()
  await expect(page.getByTestId('export-status')).toHaveAttribute('data-state', 'done', { timeout: 180_000 })
  expect((await download).suggestedFilename()).toBe('Demo phonk edit.mp4')

  const tracks = await page.evaluate(async () => {
    const w = window as unknown as {
      __aieditor: {
        exportDebug: {
          lastExport(): { blob: Blob | null; sources: Record<string, string> } | null
          exportedTracks(b: Blob): Promise<{ video: string | null; audio: string | null; duration: number }>
        }
      }
    }
    const last = w.__aieditor.exportDebug.lastExport()
    if (!last?.blob) return null
    return { ...(await w.__aieditor.exportDebug.exportedTracks(last.blob)), sources: last.sources }
  })
  expect(tracks).not.toBeNull()
  expect(tracks!.video).not.toBeNull()
  expect(tracks!.audio).not.toBeNull()
  expect(tracks!.duration).toBeGreaterThan(0.95)
  expect(tracks!.duration).toBeLessThan(1.1)
  expect(Object.values(tracks!.sources).every((url) => url.endsWith('/original'))).toBe(true)

  await page.getByTestId('export-close').click()
  await expect(dialog).toBeHidden()

  for (const i of ALIGNED_FRAMES) {
    const t = IN + i / FPS
    await setPlayhead(page, t)
    await expect
      .poll(
        () =>
          page.evaluate(
            ({ w, h }) => {
              const win = window as unknown as {
                __aieditor: { exportDebug: { capturePreview(w: number, h: number): { sources: string[] } } }
              }
              const sources = win.__aieditor.exportDebug.capturePreview(w, h).sources
              return sources.length > 0 && sources.every((s) => s === 'video')
            },
            { w: WIDTH, h: HEIGHT },
          ),
        { timeout: 20_000 },
      )
      .toBe(true)
    const value = await page.evaluate(
      async ({ w, h, at, time }) => {
        const win = window as unknown as {
          __aieditor: {
            exportDebug: {
              capturePreview(w: number, h: number): { image: ImageData; sources: string[] }
              renderExportFrame(t: number, w: number, h: number): Promise<ImageData>
              decodeFrame(b: Blob, t: number): Promise<ImageData | null>
              psnr(a: ImageData, b: ImageData): number
              lastExport(): { blob: Blob | null } | null
            }
          }
        }
        const dbg = win.__aieditor.exportDebug
        const preview = dbg.capturePreview(w, h).image
        const rendered = await dbg.renderExportFrame(time, w, h)
        const exported = await dbg.decodeFrame(dbg.lastExport()!.blob!, at)
        if (!exported) return { render: -1, file: -1 }
        return { render: dbg.psnr(preview, rendered), file: dbg.psnr(preview, exported) }
      },
      { w: WIDTH, h: HEIGHT, at: (i + 0.5) / FPS, time: t },
    )
    expect(value.render, `рендер экспорта = превью, кадр ${i}`).toBe(Infinity)
    expect(value.file, `PSNR кадра ${i}`).toBeGreaterThan(40)
  }
})

test('exports an After Effects script', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true })
  })
  await page.goto('/')
  await page.getByRole('button', { name: 'Демо-проект' }).click()
  await page.getByTestId('open-export').click()
  const download = page.waitForEvent('download')
  await page.getByTestId('export-ae').click()
  expect((await download).suggestedFilename()).toBe('Demo phonk edit.jsx')
  await expect(page.getByTestId('export-ae-status')).toContainText('сохранён')
})

test('export can be canceled', async ({ page }) => {
  test.setTimeout(120_000)
  await page.addInitScript(() => {
    Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true })
  })
  await page.goto('/')
  await page.getByRole('button', { name: 'Демо-проект' }).click()
  await page.getByTestId('open-export').click()
  await page.getByTestId('export-resolution').selectOption('720p')
  await expect(page.getByTestId('export-start')).toBeEnabled({ timeout: 30_000 })
  await page.getByTestId('export-start').click()
  await expect(page.getByTestId('export-progress')).toBeVisible({ timeout: 60_000 })
  await expect
    .poll(async () => Number(await page.getByTestId('export-progress').getAttribute('data-fraction')), {
      timeout: 60_000,
    })
    .toBeGreaterThan(0)
  await page.getByTestId('export-cancel').click()
  await expect(page.getByTestId('export-status')).toHaveAttribute('data-state', 'idle')
  await expect(page.getByTestId('export-status')).toContainText('отменён')
})

test('export streams into the file chosen in the save picker', async ({ page }) => {
  test.setTimeout(120_000)
  await page.addInitScript(() => {
    Object.defineProperty(window, 'showSaveFilePicker', {
      configurable: true,
      value: async (options: { suggestedName?: string }) => {
        const dir = await navigator.storage.getDirectory()
        ;(window as unknown as { __savedName?: string }).__savedName = options.suggestedName
        return dir.getFileHandle('picked.mp4', { create: true })
      },
    })
  })
  await page.goto('/')
  await page.getByRole('button', { name: 'Демо-проект' }).click()
  await setPlayhead(page, 2)
  await page.locator('body').press('i')
  await setPlayhead(page, 3)
  await page.locator('body').press('o')
  await page.getByTestId('open-export').click()
  await page.getByTestId('export-resolution').selectOption('720p')
  await expect(page.getByTestId('export-start')).toBeEnabled({ timeout: 30_000 })
  await page.getByTestId('export-start').click()
  await expect(page.getByTestId('export-status')).toHaveAttribute('data-state', 'done', { timeout: 120_000 })
  await expect(page.getByTestId('export-status')).toContainText('сохранено')
  const info = await page.evaluate(async () => {
    const dir = await navigator.storage.getDirectory()
    const file = await (await dir.getFileHandle('picked.mp4')).getFile()
    const w = window as unknown as {
      __savedName?: string
      __aieditor: {
        exportDebug: {
          exportedTracks(b: Blob): Promise<{ video: string | null; audio: string | null; duration: number }>
        }
      }
    }
    return { name: w.__savedName, size: file.size, ...(await w.__aieditor.exportDebug.exportedTracks(file)) }
  })
  expect(info.name).toBe('Demo phonk edit.mp4')
  expect(info.size).toBeGreaterThan(10_000)
  expect(info.video).not.toBeNull()
  expect(info.audio).not.toBeNull()
  expect(info.duration).toBeGreaterThan(0.95)
  expect(info.duration).toBeLessThan(1.1)
})
