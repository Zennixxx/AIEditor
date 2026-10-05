// Искажения: rgbSplit, chromaWave.
import { num, type EffectModule } from './types'

const rgbSplit: EffectModule = {
  id: 'rgbSplit',
  fragment: `
uniform vec2 u_shift; // uv-сдвиг красного (синий — в противоположную сторону)
void main() {
  vec4 r = texture(u_tex, v_uv + u_shift);
  vec4 g = texture(u_tex, v_uv);
  vec4 b = texture(u_tex, v_uv - u_shift);
  o_color = vec4(r.r, g.g, b.b, max(g.a, max(r.a, b.a)));
}`,
  uniforms({ pass, px, res }) {
    const a = (num(pass.params, 'angle') * Math.PI) / 180
    const d = num(pass.params, 'amount', 12) * px * pass.intensity
    return { u_shift: [(Math.cos(a) * d) / res[0], (Math.sin(a) * d) / res[1]] }
  },
}

const chromaWave: EffectModule = {
  id: 'chromaWave',
  fragment: `
uniform float u_amount;    // uv по x
uniform float u_frequency; // волн на высоту кадра
uniform float u_phase;
void main() {
  float d = sin((v_uv.y * u_frequency + u_phase) * 2.0 * PI) * u_amount;
  vec4 r = texture(u_tex, v_uv + vec2(d, 0.0));
  vec4 g = texture(u_tex, v_uv);
  vec4 b = texture(u_tex, v_uv - vec2(d, 0.0));
  o_color = vec4(r.r, g.g, b.b, max(g.a, max(r.a, b.a)));
}`,
  uniforms({ pass, px, res }) {
    const { params, tau } = pass
    return {
      u_amount: (num(params, 'amount', 8) * px * pass.intensity) / res[0],
      u_frequency: num(params, 'frequency', 3),
      u_phase: tau * num(params, 'speed', 2),
    }
  },
}

export const distortEffects = [rgbSplit, chromaWave]
