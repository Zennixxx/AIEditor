const SLOW: [number, number, number] = [61, 139, 255]
const FAST: [number, number, number] = [255, 77, 77]
const NORMAL: [number, number, number] = [150, 156, 170]
const RANGE = Math.log(4)

export function speedColor(speed: number): string {
  const t = Math.max(-1, Math.min(1, Math.log(Math.max(speed, 1e-3)) / RANGE))
  const target = t < 0 ? SLOW : FAST
  const a = Math.abs(t)
  const c = NORMAL.map((n, i) => Math.round(n + (target[i]! - n) * a))
  return `rgb(${c[0]},${c[1]},${c[2]})`
}
