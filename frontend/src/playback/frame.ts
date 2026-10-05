// Геометрия кадра превью (Canvas 2D до WebGL фазы 4). Чистые функции.

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/** Вписать кадр проекта (aspect `aw:ah`) в область `w×h` без обрезки, по центру. */
export function containRect(aw: number, ah: number, w: number, h: number): Rect {
  if (aw <= 0 || ah <= 0 || w <= 0 || h <= 0) return { x: 0, y: 0, w: 0, h: 0 }
  const s = Math.min(w / aw, h / ah)
  const rw = aw * s
  const rh = ah * s
  return { x: (w - rw) / 2, y: (h - rh) / 2, w: rw, h: rh }
}

/**
 * Прямоугольник источника `sw×sh`, растянутый «cover» на выход `dw×dh` (CONTRACT §1: scale 1 = cover —
 * кадр заполняет выход без полей, лишнее обрезается по центру). Возвращает область источника для drawImage.
 */
export function coverSource(sw: number, sh: number, dw: number, dh: number): Rect {
  if (sw <= 0 || sh <= 0 || dw <= 0 || dh <= 0) return { x: 0, y: 0, w: 0, h: 0 }
  const s = Math.max(dw / sw, dh / sh)
  const w = dw / s
  const h = dh / s
  return { x: (sw - w) / 2, y: (sh - h) / 2, w, h }
}
