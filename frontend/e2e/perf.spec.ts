import { expect, test, type Page } from '@playwright/test'

// Фаза 8: таймлайн на 500 клипах и 2000 маркерах держит ≥ 60 fps при скролле.
// Бюджет кадра — время drawTimeline (dev-счётчик timelineStats), p95 < 8 мс, и частота кадров rAF.
// Запуск: npm run e2e:perf (один воркер).

interface Stats {
  draws: number
  samples: number[]
  reset(): void
}

async function buildBigProject(page: Page): Promise<void> {
  await page.evaluate(() => {
    type AnyProject = {
      assets: { id: string; kind: string; duration: number }[]
      tracks: {
        id: string
        kind: string
        name: string
        items: unknown[]
        muted: boolean
        locked: boolean
        hidden: boolean
        volume?: number
      }[]
      [k: string]: unknown
    }
    const w = window as unknown as {
      __aieditor: { useProject: { getState(): { project: AnyProject; load(p: AnyProject): void } } }
    }
    const base = w.__aieditor.useProject.getState().project
    const videos = base.assets.filter((a) => a.kind === 'video')
    const music = base.assets.find((a) => a.kind === 'audio')!
    const clip = (id: string, assetId: string, start: number, duration: number, extra: object = {}) => ({
      id,
      type: 'clip',
      assetId,
      start,
      duration,
      sourceIn: 0,
      sourceOut: duration,
      speed: 1,
      reverse: false,
      transform: { x: 0, y: 0, scale: 1, rotation: 0, anchorX: 0, anchorY: 0 },
      opacity: 1,
      blendMode: 'normal',
      volume: 1,
      effects: [],
      markers: [],
      ...extra,
    })
    const track = (id: string, kind: string, name: string, items: unknown[]) => ({
      id,
      kind,
      name,
      muted: false,
      locked: false,
      hidden: false,
      ...(kind === 'audio' ? { volume: 1 } : {}),
      items,
    })
    const v1: unknown[] = []
    const v2: unknown[] = []
    for (let i = 0; i < 500; i++) {
      const a = videos[i % videos.length]!
      const target = i % 2 ? v2 : v1
      target.push(clip(`clp_v${String(i).padStart(7, '0')}`, a.id, Math.floor(i / 2), 1))
    }
    const kinds = ['bass', 'beat', 'downbeat', 'bass']
    const audio: unknown[] = []
    let n = 0
    for (let c = 0; c < 3; c++) {
      const markers = []
      for (let k = 0; k < 667 && n < 2000; k++, n++) {
        markers.push({
          id: `mrk_p${String(n).padStart(7, '0')}`,
          t: 0.05 + k * 0.14,
          kind: kinds[k % 4],
          strength: ((k * 37) % 100) / 100,
        })
      }
      audio.push(clip(`clp_m${c}000000`, music.id, c * 84, 84, { markers }))
    }
    const fx: unknown[] = []
    for (let i = 0; i < 200; i++) {
      fx.push({
        id: `fx_p${String(i).padStart(8, '0')}`,
        type: 'effect',
        effect: 'shake',
        start: i * 1.2,
        duration: 0.4,
        params: {},
        envelope: { attack: 0.02, hold: 0.05, decay: 0.3, curve: 'exp' },
        enabled: true,
      })
    }
    w.__aieditor.useProject.getState().load({
      ...base,
      duration: 252,
      tracks: [
        track('trk_perfv1', 'video', 'V1', v1),
        track('trk_perfv2', 'video', 'V2', v2),
        track('trk_perffx', 'fx', 'FX', fx),
        track('trk_perfa1', 'audio', 'A1', audio),
      ],
      markers: [],
      sections: [],
    })
  })
}

async function scrollFor(
  page: Page,
  pxPerSec: number,
  ms: number,
): Promise<{ fps: number; p95: number; max: number; draws: number }> {
  return page.evaluate(
    async ({ pxPerSec, ms }) => {
      const w = window as unknown as {
        __aieditor: {
          useUi: { getState(): { setScroll(x: number): void }; setState(s: object): void }
          timelineStats: Stats
        }
      }
      w.__aieditor.useUi.setState({ pxPerSec, scrollX: 0, scrollY: 0 })
      await new Promise((r) => setTimeout(r, 300))
      w.__aieditor.timelineStats.reset()
      const start = performance.now()
      let frames = 0
      await new Promise<void>((done) => {
        const step = (now: number) => {
          const t = now - start
          w.__aieditor.useUi.getState().setScroll(((t / 1000) * 30) % 200)
          frames++
          if (t < ms) requestAnimationFrame(step)
          else done()
        }
        requestAnimationFrame(step)
      })
      const elapsed = performance.now() - start
      const s = [...w.__aieditor.timelineStats.samples].sort((a, b) => a - b)
      return {
        fps: (frames / elapsed) * 1000,
        p95: s[Math.floor(s.length * 0.95)] ?? 0,
        max: s[s.length - 1] ?? 0,
        draws: w.__aieditor.timelineStats.draws,
      }
    },
    { pxPerSec, ms },
  )
}

test('timeline with 500 clips and 2000 markers scrolls at 60 fps', async ({ page }) => {
  // замер имеет смысл только без соседних воркеров: npx playwright test e2e/perf.spec.ts --workers=1
  test.skip(test.info().config.workers > 1, 'perf — только с --workers=1')
  await page.setViewportSize({ width: 1920, height: 1080 })
  await page.goto('/')
  await page.getByRole('button', { name: 'Демо-проект' }).click()
  await expect(page.getByTestId('project-name')).toHaveValue('Demo phonk edit')
  await buildBigProject(page)
  await expect(page.locator('[data-clip-count="503"]')).toBeVisible()

  for (const zoom of [40, 8, 2]) {
    const r = await scrollFor(page, zoom, 3000)
    console.log(
      `zoom ${zoom} px/s: ${r.fps.toFixed(1)} fps, draws ${r.draws}, draw p95 ${r.p95.toFixed(2)} ms, max ${r.max.toFixed(2)} ms`,
    )
    expect(r.draws).toBeGreaterThan(100)
    expect(r.p95).toBeLessThan(8)
    expect(r.fps).toBeGreaterThan(55)
  }
})
