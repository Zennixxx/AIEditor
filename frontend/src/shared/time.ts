/** Квантование времени к сетке кадров проекта (CONTRACT §1). */
export function snapToFrame(t: number, fps: number): number {
  return Math.round(t * fps) / fps
}

/** Таймкод `mm:ss:ff` (или `h:mm:ss:ff`, если есть часы). */
export function formatTimecode(t: number, fps: number): string {
  const totalFrames = Math.max(0, Math.round(t * fps))
  const frames = totalFrames % Math.round(fps)
  const totalSeconds = Math.floor(totalFrames / Math.round(fps))
  const s = totalSeconds % 60
  const m = Math.floor(totalSeconds / 60) % 60
  const h = Math.floor(totalSeconds / 3600)
  const pad = (n: number) => String(n).padStart(2, '0')
  const core = `${pad(m)}:${pad(s)}:${pad(frames)}`
  return h > 0 ? `${h}:${core}` : core
}

export const FRAME_EPS = 1e-4
