// Цвет: invert, contrastPunch. Работают по непремультиплицированному цвету.
import { num, type EffectModule } from './types'

const invert: EffectModule = {
  id: 'invert',
  fragment: `
uniform float u_mix;
void main() {
  vec4 c = texture(u_tex, v_uv);
  vec3 rgb = unpremul(c);
  o_color = premul(mix(rgb, 1.0 - rgb, u_mix), c.a);
}`,
  uniforms: ({ pass }) => ({ u_mix: Math.min(num(pass.params, 'mix', 1) * pass.intensity, 1) }),
}

const contrastPunch: EffectModule = {
  id: 'contrastPunch',
  fragment: `
uniform float u_contrast;
uniform float u_saturation;
uniform float u_gain;
void main() {
  vec4 c = texture(u_tex, v_uv);
  vec3 rgb = unpremul(c) * u_gain;
  rgb = (rgb - 0.5) * u_contrast + 0.5;
  float l = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
  rgb = mix(vec3(l), rgb, u_saturation);
  o_color = premul(clamp(rgb, 0.0, 1.0), c.a);
}`,
  uniforms({ pass }) {
    const { params } = pass
    const k = pass.intensity
    return {
      u_contrast: 1 + (num(params, 'contrast', 1.4) - 1) * k,
      u_saturation: Math.max(0, 1 + (num(params, 'saturation', 1.3) - 1) * k),
      u_gain: Math.pow(2, num(params, 'exposure', 0.2) * k),
    }
  },
}

export const colorEffects = [invert, contrastPunch]
