import { describe, expect, it } from 'vitest'
import { psnr, type Pixels } from './compare'

function solid(width: number, height: number, v: number): Pixels {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < data.length; i += 4) data.set([v, v, v, 255], i)
  return { width, height, data }
}

describe('psnr', () => {
  it('is infinite for identical frames', () => {
    expect(psnr(solid(4, 4, 100), solid(4, 4, 100))).toBe(Infinity)
  })

  it('matches 20·log10(255 / |Δ|) for a uniform luma offset', () => {
    expect(psnr(solid(4, 4, 100), solid(4, 4, 102))).toBeCloseTo(20 * Math.log10(255 / 2), 3)
  })

  it('rejects frames of different size', () => {
    expect(() => psnr(solid(2, 2, 0), solid(4, 4, 0))).toThrow()
  })
})
