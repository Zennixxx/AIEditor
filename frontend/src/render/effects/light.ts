// Свет: flicker, strobe, flash, glow. Кадр в премультиплицированной альфе — цвет добавляется только там,
// где есть изображение слоя (на fx-дорожке аккумулятор непрозрачен).
import { parseColor } from '../gl'
import { lattice } from '../noise'
import { num, str, type EffectModule, type EffectStage } from './types'

/** Яркость фликера в момент `tau`: меандр с частотой `rate`, смешанный со случайным уровнем по `randomness`. */
export function flickerLevel(seed: number, tau: number, rate: number, randomness: number): number {
  const step = Math.floor(tau * rate)
  const square = step % 2 === 0 ? 1 : 0
  const rnd = (lattice(Math.floor(seed * 4294967296), step) + 1) / 2
  return square + (rnd - square) * randomness
}

const flicker: EffectModule = {
  id: 'flicker',
  fragment: `
uniform float u_gain;
void main() {
  vec4 c = texture(u_tex, v_uv);
  o_color = vec4(c.rgb * u_gain, c.a);
}`,
  uniforms({ pass }) {
    const { params, tau, seed } = pass
    const level = flickerLevel(seed, tau, num(params, 'rate', 15), num(params, 'randomness', 0.5))
    const min = num(params, 'minBrightness', 0.3)
    const target = min + (1 - min) * level
    const k = Math.min(pass.intensity, 1)
    return { u_gain: 1 + (target - 1) * k }
  },
}

const strobe: EffectModule = {
  id: 'strobe',
  fragment: `
uniform vec3 u_color;
uniform float u_mix;
void main() {
  vec4 c = texture(u_tex, v_uv);
  o_color = vec4(mix(c.rgb, u_color * c.a, u_mix), c.a);
}`,
  uniforms({ pass }) {
    const { params, tau } = pass
    const on = Math.floor(tau * num(params, 'rate', 8)) % 2 === 0
    const [r, g, b] = parseColor(str(params, 'color', '#ffffff'))
    return { u_color: [r, g, b], u_mix: on ? Math.min(num(params, 'opacity', 1) * pass.intensity, 1) : 0 }
  },
}

const BLEND = { add: 0, screen: 1, normal: 2 } as const

const flash: EffectModule = {
  id: 'flash',
  fragment: `
uniform vec3 u_color;
uniform float u_k;
uniform float u_mode; // 0 add, 1 screen, 2 normal
void main() {
  vec4 c = texture(u_tex, v_uv);
  vec3 f = u_color * u_k * c.a;
  vec3 rgb = u_mode < 0.5 ? c.rgb + f : u_mode < 1.5 ? c.rgb + f - c.rgb * u_color * u_k : mix(c.rgb, u_color * c.a, u_k);
  o_color = vec4(min(rgb, vec3(c.a)), c.a);
}`,
  uniforms({ pass }) {
    const { params } = pass
    const [r, g, b] = parseColor(str(params, 'color', '#ffffff'))
    const mode = BLEND[str(params, 'blend', 'add') as keyof typeof BLEND] ?? 0
    return {
      u_color: [r, g, b],
      u_k: Math.min(num(params, 'opacity', 0.9) * pass.intensity, 1),
      u_mode: mode,
    }
  },
}

/** Отводов гаусса в одну сторону (проход — 2·N + 1 выборок). */
export const GLOW_TAPS = 24

/** Шаг гаусса по оси `axis` (0 — x, 1 — y): радиус `radius` px проекта — это ~3σ. */
function gaussStage(axis: 0 | 1, finish: string): EffectStage {
  return {
    fragment: `
uniform vec2 u_step; // uv-шаг между отводами
uniform float u_gain;
void main() {
  vec4 acc = texture(u_tex, v_uv);
  float wsum = 1.0;
  for (int i = 1; i <= ${GLOW_TAPS}; i++) {
    float x = float(i) / ${GLOW_TAPS}.0;
    float w = exp(-4.5 * x * x);
    acc += (texture(u_tex, v_uv + u_step * float(i)) + texture(u_tex, v_uv - u_step * float(i))) * w;
    wsum += 2.0 * w;
  }
  vec4 blur = acc / wsum;
  ${finish}
}`,
    uniforms({ pass, px, res }) {
      const r = Math.max(1, num(pass.params, 'radius', 20) * px)
      const step = r / GLOW_TAPS
      return {
        u_step: axis === 0 ? [step / res[0], 0] : [0, step / res[1]],
        u_gain: num(pass.params, 'intensity', 1.2) * pass.intensity,
      }
    },
  }
}

/** Свечение: выделение ярких мест → гаусс по x → гаусс по y + сложение с исходным кадром. */
const glow: EffectModule = {
  id: 'glow',
  stages: [
    {
      fragment: `
uniform float u_threshold;
void main() {
  vec4 c = texture(u_tex, v_uv);
  vec3 rgb = unpremul(c);
  float l = max(rgb.r, max(rgb.g, rgb.b));
  float k = smoothstep(u_threshold, min(u_threshold + 0.25, 1.0001), l);
  o_color = vec4(rgb * k * c.a, c.a);
}`,
      uniforms: ({ pass }) => ({ u_threshold: num(pass.params, 'threshold', 0.7) }),
    },
    gaussStage(0, 'o_color = blur;'),
    gaussStage(
      1,
      `vec4 src = texture(u_src, v_uv);
  o_color = vec4(min(src.rgb + blur.rgb * u_gain, vec3(src.a)), src.a);`,
    ),
  ],
}

export const lightEffects = [flicker, strobe, flash, glow]
