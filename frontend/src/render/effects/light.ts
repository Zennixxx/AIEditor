// Свет: flicker, strobe, flash. Кадр в премультиплицированной альфе — цвет добавляется только там,
// где есть изображение слоя (на fx-дорожке аккумулятор непрозрачен).
import { parseColor } from '../gl'
import { lattice } from '../noise'
import { num, str, type EffectModule } from './types'

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

export const lightEffects = [flicker, strobe, flash]
