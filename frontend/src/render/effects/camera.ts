// Эффекты камеры: shake, zoomPunch, panCrop, tilt3d.
import { easeValue } from '@/model/easing'
import { effectIntensity } from '@/model/envelope'
import type { Ease } from '@/shared/types.gen'
import { valueNoise } from '../noise'
import { bool, num, shutter, str, type EffectModule } from './types'

export const MAX_BLUR_SAMPLES = 32

/** Смещение (px цели) и поворот (рад) шейка в момент `tau`: гладкий шум с частотой `frequency`. */
export function shakeOffset(
  seed: number,
  tau: number,
  frequency: number,
  amountPx: number,
  rotationDeg: number,
  intensity: number,
): [number, number, number] {
  const s = Math.floor(seed * 4294967296)
  const x = tau * frequency
  return [
    valueNoise(s, x) * amountPx * intensity,
    valueNoise(s + 7919, x) * amountPx * intensity,
    ((valueNoise(s + 15485, x) * rotationDeg * Math.PI) / 180) * intensity,
  ]
}

const shakeOffsets = new Float32Array(MAX_BLUR_SAMPLES * 3)

const shake: EffectModule = {
  id: 'shake',
  fragment: `
uniform vec3 u_offsets[${MAX_BLUR_SAMPLES}]; // (dx px, dy px, rot рад) по сэмплам выдержки
uniform float u_n;
void main() {
  vec2 c = u_res * 0.5;
  vec4 acc = vec4(0.0);
  for (int i = 0; i < ${MAX_BLUR_SAMPLES}; i++) {
    if (float(i) >= u_n) break;
    vec3 o = u_offsets[i];
    vec2 p = v_uv * u_res - c - o.xy;
    float cs = cos(-o.z), sn = sin(-o.z);
    p = vec2(cs * p.x - sn * p.y, sn * p.x + cs * p.y) + c;
    acc += texture(u_tex, p / u_res);
  }
  o_color = acc / u_n;
}`,
  uniforms({ pass, fps, px }) {
    const { params, item, tau, seed } = pass
    const n = bool(params, 'motionBlur')
      ? Math.max(1, Math.min(MAX_BLUR_SAMPLES, Math.round(num(params, 'samples', 8))))
      : 1
    const freq = num(params, 'frequency', 12)
    const amount = num(params, 'amount', 40) * px
    const rot = num(params, 'rotation', 3)
    const span = shutter(fps)
    for (let i = 0; i < n; i++) {
      const t = n > 1 ? tau - (span * i) / (n - 1) : tau
      const k = i === 0 ? pass.intensity : effectIntensity(item, Math.max(0, t))
      const o = shakeOffset(seed, t, freq, amount, rot, k)
      shakeOffsets[i * 3] = o[0]
      shakeOffsets[i * 3 + 1] = o[1]
      shakeOffsets[i * 3 + 2] = o[2]
    }
    return { u_offsets: { vec3: shakeOffsets }, u_n: n }
  },
}

const zoomPunch: EffectModule = {
  id: 'zoomPunch',
  fragment: `
uniform vec2 u_center;   // uv центра зума
uniform float u_scale0;  // масштаб в начале выдержки
uniform float u_scale1;  // масштаб в кадре
uniform float u_n;
void main() {
  vec4 acc = vec4(0.0);
  for (int i = 0; i < 16; i++) {
    if (float(i) >= u_n) break;
    float s = mix(u_scale1, u_scale0, u_n > 1.0 ? float(i) / (u_n - 1.0) : 0.0);
    acc += texture(u_tex, u_center + (v_uv - u_center) / s);
  }
  o_color = acc / u_n;
}`,
  uniforms({ pass, fps }) {
    const { params, item, tau } = pass
    const amount = num(params, 'amount', 1.15)
    const scale = (k: number) => Math.max(0.05, 1 + (amount - 1) * k)
    const prev = effectIntensity(item, Math.max(0, tau - shutter(fps)))
    return {
      u_center: [(num(params, 'centerX') + 1) / 2, (num(params, 'centerY') + 1) / 2],
      u_scale0: scale(prev),
      u_scale1: scale(pass.intensity),
      u_n: bool(params, 'motionBlur') ? 12 : 1,
    }
  },
}

const panCrop: EffectModule = {
  id: 'panCrop',
  fragment: `
uniform float u_scale;
uniform vec2 u_offset; // сдвиг содержимого, uv
void main() {
  o_color = texture(u_tex, vec2(0.5) + (v_uv - vec2(0.5) - u_offset) / u_scale);
}`,
  uniforms({ pass }) {
    const { params, item, tau } = pass
    const ease = str(params, 'ease', 'easeInOut') as Ease
    const p = easeValue(ease, Math.min(Math.max(tau / item.duration, 0), 1))
    const lerp = (a: string, b: string, d: number) =>
      num(params, a, d) + (num(params, b, d) - num(params, a, d)) * p
    const k = Math.min(pass.intensity, 1)
    const s = 1 + (lerp('fromScale', 'toScale', 1) - 1) * k
    return {
      u_scale: Math.max(0.05, s),
      u_offset: [(lerp('fromX', 'toX', 0) * k) / 2, (lerp('fromY', 'toY', 0) * k) / 2],
    }
  },
}

const tiltRot = new Float32Array(9)

const tilt3d: EffectModule = {
  id: 'tilt3d',
  fragment: `
uniform mat3 u_rot;     // поворот плоскости кадра
uniform float u_dist;   // расстояние до камеры (в половинах высоты кадра)
void main() {
  float aspect = u_res.x / u_res.y;
  // точка экрана в единицах «половина высоты», y вниз
  vec3 s = vec3((v_uv.x * 2.0 - 1.0) * aspect, v_uv.y * 2.0 - 1.0, 0.0);
  vec3 eye = vec3(0.0, 0.0, -u_dist);
  vec3 n = u_rot * vec3(0.0, 0.0, 1.0);
  vec3 dir = s - eye;
  float denom = dot(n, dir);
  if (abs(denom) < 1e-5) { o_color = vec4(0.0); return; }
  float t = -dot(n, eye) / denom;
  vec3 q = transpose(u_rot) * (eye + t * dir);
  vec2 uv = vec2(q.x / aspect, q.y) * 0.5 + 0.5;
  o_color = t > 0.0 ? texture(u_tex, uv) : vec4(0.0);
}`,
  uniforms({ pass }) {
    const { params } = pass
    const k = pass.intensity
    const ax = (num(params, 'angleX', 10) * k * Math.PI) / 180
    const ay = (num(params, 'angleY', 15) * k * Math.PI) / 180
    const cx = Math.cos(ax)
    const sx = Math.sin(ax)
    const cy = Math.cos(ay)
    const sy = Math.sin(ay)
    // R = Ry · Rx, column-major
    tiltRot.set([cy, 0, -sy, sy * sx, cx, cy * sx, sy * cx, -sx, cy * cx])
    return { u_rot: { mat3: tiltRot }, u_dist: num(params, 'perspective', 1.5) * 2 }
  },
}

export const cameraEffects = [shake, zoomPunch, panCrop, tilt3d]
