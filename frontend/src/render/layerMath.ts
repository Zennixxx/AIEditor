// Геометрия слоя (CONTRACT §1): cover-вписывание + transform. Чистые функции.
//
// Координаты выхода — пиксели цели, ось y вниз, начало в левом верхнем углу.
// Точка слоя q (пиксели от центра слоя) попадает в  p = C + P + A + R(θ)·s·(q − A),
// где C — центр кадра, P = (x·W/2, y·H/2), A = (anchorX·lw/2, anchorY·lh/2), θ — по часовой стрелке.

export interface LayerTransform {
  x: number
  y: number
  scale: number
  rotation: number
  anchorX: number
  anchorY: number
}

export const IDENTITY_TRANSFORM: LayerTransform = {
  x: 0,
  y: 0,
  scale: 1,
  rotation: 0,
  anchorX: 0,
  anchorY: 0,
}

/**
 * Матрица 3×3 (column-major, для uniformMatrix3fv): пиксель выхода (px, py, 1) → uv источника 0..1
 * (u вправо, v вниз). Источник `sw×sh` вписывается «cover» в `W×H`.
 */
export function layerUvMatrix(W: number, H: number, sw: number, sh: number, t: LayerTransform): Float32Array {
  const cs = Math.max(W / sw, H / sh)
  const lw = sw * cs
  const lh = sh * cs
  const s = Math.abs(t.scale) > 1e-9 ? t.scale : 1e-9
  const th = (t.rotation * Math.PI) / 180
  const cos = Math.cos(th)
  const sin = Math.sin(th)
  const ax = (t.anchorX * lw) / 2
  const ay = (t.anchorY * lh) / 2
  // d = p − (C + P + A);  q = A + R(−θ)·d / s;  uv = (q + L/2) / L
  const ox = W / 2 + (t.x * W) / 2 + ax
  const oy = H / 2 + (t.y * H) / 2 + ay
  // R(−θ) = [[cos, sin], [−sin, cos]]
  const a = cos / s
  const b = sin / s
  const c = -sin / s
  const d = cos / s
  // q = A + M·(p − O), где M = [[a, b], [c, d]]
  const qx0 = ax - (a * ox + b * oy)
  const qy0 = ay - (c * ox + d * oy)
  // uv = q / L + 1/2
  const m00 = a / lw
  const m01 = b / lw
  const m10 = c / lh
  const m11 = d / lh
  const tx = qx0 / lw + 0.5
  const ty = qy0 / lh + 0.5
  // column-major: [col0, col1, col2]
  return new Float32Array([m00, m10, 0, m01, m11, 0, tx, ty, 1])
}

/** Применить матрицу из layerUvMatrix к точке (для тестов и отладки). */
export function applyUvMatrix(m: Float32Array, px: number, py: number): [number, number] {
  return [m[0]! * px + m[3]! * py + m[6]!, m[1]! * px + m[4]! * py + m[7]!]
}
