// Переходы: whipPan, zoomTransition, blurTransition, flashTransition, glitchTransition.
//
// Переход — эффект fx-дорожки, центрованный на стыке двух клипов (model/transitions.ts): он видит один кадр
// (композит ниже), до середины — клип A, после — клип B. Движение задаётся положением внутри эффекта
// (`progress`, стык — 0.5): до стыка кадр «уходит» с ускорением, после — «приходит» с замедлением; сила
// размытия/вспышки — огибающей (`u_intensity`). При intensity = 0 и на краях эффекта — тождество.
import { parseColor } from '../gl'
import { num, progress, str, type EffectModule } from './types'

const MAX_SAMPLES = 48

/** Смещение кадра перехода в долях кадра: 0 → ±0.5 у стыка (скачок на целый кадр — смена клипа) → 0. */
export function transitionTravel(pos: number): number {
  return pos < 0.5 ? 0.5 * (2 * pos) ** 2 : -0.5 * (2 * (1 - pos)) ** 2
}

/** |d travel / d pos| — для длины смаза. */
function travelSpeed(pos: number): number {
  return pos < 0.5 ? 4 * pos : 4 * (1 - pos)
}

/** Направление «ухода» кадра: куда сдвигается изображение (uv-сдвиг выборки — с тем же знаком по оси). */
const WHIP_DIRS: Record<string, [number, number]> = {
  left: [1, 0],
  right: [-1, 0],
  up: [0, 1],
  down: [0, -1],
}

const whipPan: EffectModule = {
  id: 'whipPan',
  fragment: `
uniform vec2 u_offset; // uv-сдвиг выборки
uniform vec2 u_blur;   // полный размах смаза, uv
uniform float u_n;
void main() {
  vec4 acc = vec4(0.0);
  for (int i = 0; i < ${MAX_SAMPLES}; i++) {
    if (float(i) >= u_n) break;
    float t = u_n > 1.0 ? float(i) / (u_n - 1.0) - 0.5 : 0.0;
    // fract — кадр «лентой» (повтор, а не зеркало): уходящий и приходящий кадры идут одной полосой
    acc += texture(u_tex, fract(v_uv + u_offset + u_blur * t));
  }
  o_color = acc / u_n;
}`,
  uniforms({ pass, px, res, fps }) {
    const pos = progress(pass)
    const [dx, dy] = WHIP_DIRS[str(pass.params, 'direction', 'left')] ?? WHIP_DIRS.left!
    const travel = transitionTravel(pos)
    // смаз: путь кадра за один кадр проекта (выдержка 360°) + параметр blur × огибающая
    const motion = travelSpeed(pos) / Math.max(pass.item.duration * fps, 1)
    const blurPx = num(pass.params, 'blur', 60) * px * pass.intensity
    const span = [dx * (motion + blurPx / res[0]), dy * (motion + blurPx / res[1])]
    const len = Math.hypot(span[0]! * res[0], span[1]! * res[1])
    return {
      u_offset: [dx * travel, dy * travel],
      u_blur: span,
      u_n: Math.max(1, Math.min(MAX_SAMPLES, Math.ceil(len / 3))),
    }
  },
}

/** Масштаб зум-перехода: 1 → amount у стыка → 1. */
export function zoomTransitionScale(pos: number, amount: number): number {
  const p = pos < 0.5 ? 2 * pos : 2 * (1 - pos)
  return 1 + (amount - 1) * p * p
}

const zoomTransition: EffectModule = {
  id: 'zoomTransition',
  fragment: `
uniform float u_scale;
uniform float u_amount; // радиальный смаз, доля радиуса
uniform float u_n;
void main() {
  vec2 c = vec2(0.5);
  vec2 uv = c + (v_uv - c) / u_scale;
  vec4 acc = vec4(0.0);
  for (int i = 0; i < ${MAX_SAMPLES}; i++) {
    if (float(i) >= u_n) break;
    float s = 1.0 - u_amount * float(i) / max(u_n - 1.0, 1.0);
    acc += texture(u_tex, c + (uv - c) * s);
  }
  o_color = acc / u_n;
}`,
  uniforms({ pass }) {
    const pos = progress(pass)
    const amount = num(pass.params, 'amount', 2)
    return {
      u_scale: zoomTransitionScale(pos, amount),
      u_amount: Math.min(num(pass.params, 'blur', 0.4) * pass.intensity * 0.5, 0.9),
      u_n: 24,
    }
  },
}

const blurTransition: EffectModule = {
  id: 'blurTransition',
  fragment: `
uniform float u_radius; // px цели
void main() {
  vec4 acc = texture(u_tex, v_uv);
  for (int i = 0; i < ${MAX_SAMPLES}; i++) {
    float f = (float(i) + 0.5) / ${MAX_SAMPLES}.0;
    float a = float(i) * 2.399963;
    acc += texture(u_tex, v_uv + vec2(cos(a), sin(a)) * sqrt(f) * u_radius / u_res);
  }
  o_color = acc / ${MAX_SAMPLES + 1}.0;
}`,
  uniforms: ({ pass, px }) => ({ u_radius: num(pass.params, 'amount', 40) * px * pass.intensity }),
}

const flashTransition: EffectModule = {
  id: 'flashTransition',
  fragment: `
uniform vec3 u_color;
uniform float u_k;
void main() {
  vec4 c = texture(u_tex, v_uv);
  o_color = vec4(mix(c.rgb, u_color * c.a, u_k), c.a);
}`,
  uniforms({ pass }) {
    const [r, g, b] = parseColor(str(pass.params, 'color', '#ffffff'))
    return { u_color: [r, g, b], u_k: Math.min(pass.intensity, 1) }
  },
}

const glitchTransition: EffectModule = {
  id: 'glitchTransition',
  fragment: `
uniform float u_blocks;
uniform float u_k;
uniform vec2 u_rgb; // uv-сдвиг каналов
void main() {
  float band = floor(v_uv.y * u_blocks);
  float salt = u_frame + u_seed * 1000.0;
  // доля сдвинутых полос растёт с интенсивностью
  float on = step(1.0 - 0.8 * u_k, hash12(vec2(band, salt)));
  float dx = (hash12(vec2(band * 3.1, salt * 1.7 + 5.0)) - 0.5) * 0.3 * u_k * on;
  vec2 uv = v_uv + vec2(dx, 0.0);
  vec4 r = texture(u_tex, uv + u_rgb);
  vec4 g = texture(u_tex, uv);
  vec4 b = texture(u_tex, uv - u_rgb);
  o_color = vec4(r.r, g.g, b.b, max(g.a, max(r.a, b.a)));
}`,
  uniforms({ pass, px, res }) {
    const k = Math.min(pass.intensity, 1)
    return {
      u_blocks: Math.max(2, Math.round(num(pass.params, 'blocks', 12))),
      u_k: k,
      u_rgb: [(num(pass.params, 'rgb', 20) * px * k) / res[0], 0],
    }
  },
}

export const transitionEffects = [whipPan, zoomTransition, blurTransition, flashTransition, glitchTransition]
