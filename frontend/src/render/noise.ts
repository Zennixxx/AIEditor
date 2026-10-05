// Детерминированный шум на CPU: одинаковый результат в превью и экспорте (сид — hash(effect.id)).

/** FNV-1a 32 бита. */
export function hash32(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** Сид эффекта 0..1 (передаётся в шейдер как `u_seed`). */
export function effectSeed(effectId: string): number {
  return hash32(effectId) / 4294967296
}

/** Псевдослучайное значение в [-1, 1] для целой точки решётки `i` и сида. */
export function lattice(seed: number, i: number): number {
  let h = (Math.imul(i | 0, 0x27d4eb2d) ^ Math.imul(seed | 0, 0x165667b1)) >>> 0
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b) >>> 0
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0
  h = (h ^ (h >>> 16)) >>> 0
  return (h / 4294967295) * 2 - 1
}

/** Гладкий 1D value-noise в [-1, 1] (smoothstep между точками решётки). */
export function valueNoise(seed: number, x: number): number {
  const i = Math.floor(x)
  const f = x - i
  const u = f * f * (3 - 2 * f)
  const a = lattice(seed, i)
  const b = lattice(seed, i + 1)
  return a + (b - a) * u
}
