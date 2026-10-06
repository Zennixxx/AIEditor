import { expect, test, type Page } from '@playwright/test'

// Фаза 8: проекты и автосейв, конфликт версий, настройки, горячие клавиши.

type Store<T> = { getState(): T; setState(s: Partial<T>): void }
interface Debug {
  useProject: Store<{
    project: { id: string; name: string; revision: number; tracks: { items: unknown[] }[] }
  }>
  useUi: Store<{ playhead: number; setPlayhead(t: number): void }>
}

const clipCount = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { __aieditor: Debug }
    return w.__aieditor.useProject
      .getState()
      .project.tracks.reduce(
        (n, t) => n + t.items.filter((i) => (i as { type: string }).type === 'clip').length,
        0,
      )
  })

const projectInfo = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { __aieditor: Debug }
    const p = w.__aieditor.useProject.getState().project
    return { id: p.id, name: p.name, revision: p.revision }
  })

async function openDemo(page: Page): Promise<void> {
  await page.goto('/')
  await page.getByRole('button', { name: 'Демо-проект' }).click()
  await expect(page.getByTestId('project-name')).toHaveValue('Demo phonk edit')
  await expect(page.getByTestId('save-status')).toHaveText('Сохранено')
}

test('rename and edits autosave; projects dialog creates, reopens and deletes projects', async ({ page }) => {
  await openDemo(page)
  const demo = await projectInfo(page)
  const clips = await clipCount(page)

  const name = page.getByTestId('project-name')
  await name.fill('Мой эдит')
  await name.press('Enter')
  await expect(page.getByTestId('save-status')).toHaveText('Изменён')
  await expect(page.getByTestId('save-status')).toHaveText('Сохранено', { timeout: 10_000 })
  expect((await projectInfo(page)).revision).toBe(demo.revision + 1)

  await page.evaluate(() => {
    const w = window as unknown as { __aieditor: Debug }
    w.__aieditor.useUi.getState().setPlayhead(1.5)
  })
  await page.keyboard.press('Control+KeyK')
  const split = await clipCount(page)
  expect(split).toBeGreaterThan(clips)
  await page.keyboard.press('Control+KeyS')
  await expect(page.getByTestId('save-status')).toHaveText('Сохранено')

  await page.keyboard.press('Control+KeyO')
  const dialog = page.getByTestId('projects-dialog')
  await expect(dialog).toBeVisible()
  await expect(dialog.getByTestId(`recent-${demo.id}`)).toContainText('Мой эдит')
  await expect(dialog.getByTestId(`project-${demo.id}`)).toContainText('Открыт')
  await dialog.getByTestId('new-project-name').fill('Вертикальный')
  await dialog.getByLabel('Размер кадра').selectOption({ label: '1080×1920 (9:16, вертикальное)' })
  await dialog.getByTestId('create-project').click()
  await expect(dialog).toBeHidden()
  await expect(name).toHaveValue('Вертикальный')
  await expect(page.getByTestId('save-status')).toHaveText('Новый')
  expect(await clipCount(page)).toBe(0)

  await page.getByTestId('open-projects').click()
  await expect(dialog.getByTestId(`project-${demo.id}`)).toBeVisible()
  await dialog.getByTestId(`project-${demo.id}`).getByRole('button', { name: 'Открыть' }).click()
  await expect(name).toHaveValue('Мой эдит')
  expect(await clipCount(page)).toBe(split)

  await page.getByTestId('open-projects').click()
  await dialog.getByTestId(`project-${demo.id}`).getByRole('button', { name: 'Удалить' }).click()
  await dialog.getByTestId(`project-${demo.id}`).getByTestId(`confirm-delete-${demo.id}`).click()
  await expect(dialog.getByTestId(`project-${demo.id}`)).toHaveCount(0)
  await expect(dialog.getByText('Сохранённых проектов пока нет')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(name).toHaveValue('Без названия')
})

test('409 from another window: reload or overwrite', async ({ page }) => {
  await openDemo(page)
  const id = (await projectInfo(page)).id
  const otherWindowSave = (newName: string) =>
    page.evaluate(
      async ({ id, newName }) => {
        const base = 'http://127.0.0.1:8765/api'
        const p = await (await fetch(`${base}/projects/${id}`)).json()
        await fetch(`${base}/projects/${id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...p, name: newName }),
        })
      },
      { id, newName },
    )

  await otherWindowSave('Из другого окна')
  const name = page.getByTestId('project-name')
  await name.fill('Моя версия')
  await name.press('Enter')
  await expect(page.getByTestId('save-conflict')).toBeVisible({ timeout: 10_000 })
  await expect(page.getByTestId('save-status')).toHaveText('Конфликт версий')
  await page.getByTestId('conflict-reload').click()
  await expect(name).toHaveValue('Из другого окна')
  await expect(page.getByTestId('save-status')).toHaveText('Сохранено')

  await otherWindowSave('Снова другое окно')
  await name.fill('Моя версия 2')
  await name.press('Enter')
  await expect(page.getByTestId('save-conflict')).toBeVisible({ timeout: 10_000 })
  await page.getByTestId('conflict-overwrite').click()
  await expect(page.getByTestId('save-status')).toHaveText('Сохранено')
  await expect(page.getByTestId('save-conflict')).toBeHidden()
  const saved = await page.evaluate(async (id) => {
    const r = await fetch(`http://127.0.0.1:8765/api/projects/${id}`)
    return (await r.json()) as { name: string }
  }, id)
  expect(saved.name).toBe('Моя версия 2')
})

test('settings: preview quality, backend info, cache cleanup', async ({ page }) => {
  await openDemo(page)
  const canvas = page.getByTestId('preview-canvas')
  const full = await canvas.evaluate((c: HTMLCanvasElement) => c.width)
  await page.getByTestId('open-settings').click()
  const dialog = page.getByTestId('settings-dialog')
  await expect(dialog.getByTestId('settings-gpu')).toContainText('NVIDIA GeForce RTX 3060')
  await expect(dialog.getByTestId('settings-disk')).toContainText('свободно 384 ГБ из 932 ГБ')
  await dialog.getByTestId('quality-0.5').click()
  await expect.poll(() => canvas.evaluate((c: HTMLCanvasElement) => c.width)).toBe(Math.round(full * 0.5))
  await dialog.getByTestId('cache-days').fill('7')
  await dialog.getByTestId('cache-clean').click()
  await expect(dialog.getByTestId('cache-result')).toContainText('удалено ассетов: 0')
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('preview-quality')).toHaveValue('0.5')
  await page.reload()
  await expect(page.getByTestId('preview-quality')).toHaveValue('0.5')
})

test('? opens the hotkeys help; a command can be rebound and reset', async ({ page }) => {
  await openDemo(page)
  const clips = await clipCount(page)
  await page.evaluate(() => {
    const w = window as unknown as { __aieditor: Debug }
    w.__aieditor.useUi.getState().setPlayhead(1.5)
  })
  await page.keyboard.press('Shift+Slash')
  const dialog = page.getByTestId('hotkeys-dialog')
  await expect(dialog).toBeVisible()
  await expect(dialog.getByTestId('hotkey-split')).toContainText('Ctrl+K')
  await dialog.getByTestId('rebind-split').click()
  await page.keyboard.press('Control+KeyB')
  await expect(dialog.getByTestId('hotkey-split')).toContainText('Ctrl+B')
  await expect(dialog.getByTestId('hotkey-split')).not.toContainText('Ctrl+K')
  await dialog.getByTestId('rebind-toggleSnap').click()
  await page.keyboard.press('KeyM')
  await expect(dialog.getByText('M снята с: Добавить маркер')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()

  await page.keyboard.press('Control+KeyK')
  expect(await clipCount(page)).toBe(clips)
  await page.keyboard.press('Control+KeyB')
  expect(await clipCount(page)).toBeGreaterThan(clips)

  await page.reload()
  await page.getByTestId('open-hotkeys').click()
  await expect(dialog.getByTestId('hotkey-split')).toContainText('Ctrl+B')
  await dialog.getByTestId('hotkeys-reset-all').click()
  await expect(dialog.getByTestId('hotkey-split')).toContainText('Ctrl+K')
  await expect(dialog.getByTestId('hotkey-addMarker')).toContainText('M')
})
