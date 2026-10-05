// Стиль: zoomBlur, directionalBlur, filmGrain, vignette, letterbox.
import { parseColor } from '../gl'
import { num, str, type EffectModule } from './types'

const zoomBlur: EffectModule = {
  id: 'zoomBlur',
  fragment: `
uniform vec2 u_center;
uniform float u_amount; // доля радиуса, на которую растягивается размытие
uniform float u_n;
void main() {
  vec4 acc = vec4(0.0);
  for (int i = 0; i < 64; i++) {
    if (float(i) >= u_n) break;
    float s = 1.0 - u_amount * float(i) / max(u_n - 1.0, 1.0);
    acc += texture(u_tex, u_center + (v_uv - u_center) * s);
  }
  o_color = acc / u_n;
}`,
  uniforms({ pass }) {
    const { params } = pass
    return {
      u_center: [(num(params, 'centerX') + 1) / 2, (num(params, 'centerY') + 1) / 2],
      u_amount: Math.min(num(params, 'amount', 0.3) * pass.intensity, 0.95),
      u_n: Math.max(1, Math.min(64, Math.round(num(params, 'samples', 16)))),
    }
  },
}

const directionalBlur: EffectModule = {
  id: 'directionalBlur',
  fragment: `
uniform vec2 u_dir; // полный размах размытия, uv
uniform float u_n;
void main() {
  vec4 acc = vec4(0.0);
  for (int i = 0; i < 64; i++) {
    if (float(i) >= u_n) break;
    float t = u_n > 1.0 ? float(i) / (u_n - 1.0) - 0.5 : 0.0;
    acc += texture(u_tex, v_uv + u_dir * t);
  }
  o_color = acc / u_n;
}`,
  uniforms({ pass, px, res }) {
    const { params } = pass
    const a = (num(params, 'angle') * Math.PI) / 180
    const len = num(params, 'amount', 30) * px * pass.intensity
    return {
      u_dir: [(Math.cos(a) * len) / res[0], (Math.sin(a) * len) / res[1]],
      u_n: Math.max(1, Math.min(64, Math.round(num(params, 'samples', 16)))),
    }
  },
}

const filmGrain: EffectModule = {
  id: 'filmGrain',
  fragment: `
uniform float u_amount;
uniform float u_size; // размер зерна, px цели
void main() {
  vec4 c = texture(u_tex, v_uv);
  vec2 cell = floor(v_uv * u_res / u_size);
  float n = hash12(cell + vec2(u_frame * 17.0, u_seed * 1000.0)) - 0.5;
  o_color = vec4(clamp(c.rgb + n * u_amount * c.a, 0.0, c.a), c.a);
}`,
  uniforms: ({ pass, px }) => ({
    u_amount: num(pass.params, 'amount', 0.15) * pass.intensity,
    u_size: Math.max(1, num(pass.params, 'size', 1.5) * px),
  }),
}

const vignette: EffectModule = {
  id: 'vignette',
  fragment: `
uniform float u_amount;
uniform float u_softness;
void main() {
  vec4 c = texture(u_tex, v_uv);
  float r = length((v_uv - 0.5) * 2.0) / sqrt(2.0); // 0 — центр, 1 — угол
  float m = 1.0 - u_amount * smoothstep(1.0 - u_softness - 0.15, 1.0, r);
  o_color = vec4(c.rgb * max(m, 0.0), c.a);
}`,
  uniforms: ({ pass }) => ({
    u_amount: num(pass.params, 'amount', 0.5) * pass.intensity,
    u_softness: num(pass.params, 'softness', 0.5),
  }),
}

const letterbox: EffectModule = {
  id: 'letterbox',
  fragment: `
uniform vec2 u_bars;  // доля кадра под полосой: (по x, по y) с каждой стороны
uniform vec3 u_color;
void main() {
  vec4 c = texture(u_tex, v_uv);
  bool bar = v_uv.x < u_bars.x || v_uv.x > 1.0 - u_bars.x || v_uv.y < u_bars.y || v_uv.y > 1.0 - u_bars.y;
  o_color = bar ? vec4(u_color, 1.0) : c;
}`,
  uniforms({ pass, res }) {
    const ratio = num(pass.params, 'ratio', 2.39)
    const frame = res[0] / res[1]
    const k = Math.min(pass.intensity, 1)
    const [r, g, b] = parseColor(str(pass.params, 'color', '#000000'))
    // кадр шире нужного — полосы по бокам, уже — сверху и снизу
    const bars = ratio >= frame ? [0, ((1 - frame / ratio) / 2) * k] : [((1 - ratio / frame) / 2) * k, 0]
    return { u_bars: bars, u_color: [r, g, b] }
  },
}

export const stylizeEffects = [zoomBlur, directionalBlur, filmGrain, vignette, letterbox]
