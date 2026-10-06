export interface Pixels {
  width: number
  height: number
  data: ArrayLike<number>
}

function luma(d: ArrayLike<number>, i: number): number {
  return 0.299 * d[i]! + 0.587 * d[i + 1]! + 0.114 * d[i + 2]!
}

export function psnr(a: Pixels, b: Pixels): number {
  if (a.width !== b.width || a.height !== b.height) throw new Error('Размеры кадров не совпадают')
  const n = a.width * a.height
  let sum = 0
  for (let p = 0; p < n; p++) {
    const diff = luma(a.data, p * 4) - luma(b.data, p * 4)
    sum += diff * diff
  }
  const mse = sum / n
  return mse === 0 ? Infinity : 10 * Math.log10((255 * 255) / mse)
}
