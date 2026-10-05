// Низкоуровневые помощники WebGL2: программы полноэкранного прохода, текстуры, цели рендера.
//
// Соглашение о текстурах: строка 0 текстуры — ВЕРХ кадра (видео/картинки загружаются без FLIP_Y).
// Во фрагментном шейдере `v_uv` ∈ [0,1]², `v_uv.y = 0` — верх кадра (ось y вниз, как в CONTRACT §1).
// Промежуточные цели рендера хранят кадр в той же ориентации; переворот — только при выводе на экран.

export const VERTEX_SHADER = `#version 300 es
out vec2 v_uv;
void main() {
  // один треугольник на весь экран
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  v_uv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`

/** Общий заголовок фрагментных шейдеров: входы, стандартные uniform и функции шума. */
export const FRAGMENT_HEADER = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 o_color;
uniform sampler2D u_tex;
uniform vec2 u_res;        // размер цели, px
uniform float u_intensity; // огибающая × strength (CONTRACT §2.1)
uniform float u_time;      // сек от начала эффекта
uniform float u_seed;      // hash(effect.id), 0..1
uniform float u_frame;     // номер кадра проекта
uniform float u_px;        // пикселей цели на пиксель проекта

const float PI = 3.141592653589793;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

vec3 unpremul(vec4 c) { return c.a > 0.0 ? c.rgb / c.a : vec3(0.0); }
vec4 premul(vec3 rgb, float a) { return vec4(rgb * a, a); }
`

export type UniformValue =
  | number
  | boolean
  | readonly number[]
  | { vec3: Float32Array }
  | { vec4: Float32Array }
  | { mat3: Float32Array }

export class Program {
  readonly program: WebGLProgram
  private readonly locations = new Map<string, WebGLUniformLocation | null>()

  constructor(
    private readonly gl: WebGL2RenderingContext,
    fragment: string,
    readonly name: string,
  ) {
    const vs = compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER, `${name}.vert`)
    const fs = compile(gl, gl.FRAGMENT_SHADER, fragment, name)
    const program = gl.createProgram()
    gl.attachShader(program, vs)
    gl.attachShader(program, fs)
    gl.linkProgram(program)
    gl.deleteShader(vs)
    gl.deleteShader(fs)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(program)
      gl.deleteProgram(program)
      throw new Error(`Шейдер ${name}: ошибка линковки\n${log}`)
    }
    this.program = program
  }

  use(): this {
    this.gl.useProgram(this.program)
    return this
  }

  private loc(name: string): WebGLUniformLocation | null {
    let l = this.locations.get(name)
    if (l === undefined) {
      l = this.gl.getUniformLocation(this.program, name)
      this.locations.set(name, l)
    }
    return l
  }

  /** Устанавливает uniform по форме значения: число/boolean → float, массив 2..4 → vecN. */
  set(name: string, value: UniformValue): this {
    const l = this.loc(name)
    if (l === null) return this
    const gl = this.gl
    if (typeof value === 'number') gl.uniform1f(l, value)
    else if (typeof value === 'boolean') gl.uniform1f(l, value ? 1 : 0)
    else if ('vec3' in value) gl.uniform3fv(l, value.vec3)
    else if ('vec4' in value) gl.uniform4fv(l, value.vec4)
    else if ('mat3' in value) gl.uniformMatrix3fv(l, false, value.mat3)
    else if (value.length === 2) gl.uniform2f(l, value[0]!, value[1]!)
    else if (value.length === 3) gl.uniform3f(l, value[0]!, value[1]!, value[2]!)
    else if (value.length === 4) gl.uniform4f(l, value[0]!, value[1]!, value[2]!, value[3]!)
    return this
  }

  setInt(name: string, value: number): this {
    const l = this.loc(name)
    if (l !== null) this.gl.uniform1i(l, value)
    return this
  }

  setMat3(name: string, m: Float32Array): this {
    const l = this.loc(name)
    if (l !== null) this.gl.uniformMatrix3fv(l, false, m)
    return this
  }

  dispose(): void {
    this.gl.deleteProgram(this.program)
  }
}

function compile(gl: WebGL2RenderingContext, type: number, source: string, name: string): WebGLShader {
  const shader = gl.createShader(type)
  if (!shader) throw new Error(`Шейдер ${name}: createShader вернул null`)
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader)
    gl.deleteShader(shader)
    throw new Error(`Шейдер ${name}: ошибка компиляции\n${log}`)
  }
  return shader
}

export function createTexture(gl: WebGL2RenderingContext, wrap: number = gl.CLAMP_TO_EDGE): WebGLTexture {
  const tex = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_2D, tex)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap)
  return tex
}

/** Цель рендера: текстура RGBA8 + framebuffer. Края — зеркальный повтор (сдвиги шейка не тянут полосы). */
export interface Target {
  tex: WebGLTexture
  fbo: WebGLFramebuffer
  w: number
  h: number
}

export function createTarget(gl: WebGL2RenderingContext, w: number, h: number): Target {
  const tex = createTexture(gl, gl.MIRRORED_REPEAT)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
  const fbo = gl.createFramebuffer()
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)
  gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  return { tex, fbo, w, h }
}

export function deleteTarget(gl: WebGL2RenderingContext, t: Target): void {
  gl.deleteFramebuffer(t.fbo)
  gl.deleteTexture(t.tex)
}

/**
 * Пул целей одного размера: `acquire` берёт свободную (создаёт только при нехватке), `release` возвращает.
 * После прогрева кадра аллокаций GL нет; при смене размера пул пересоздаётся.
 */
export class TargetPool {
  private free: Target[] = []
  private all: Target[] = []
  private w = 0
  private h = 0

  constructor(private readonly gl: WebGL2RenderingContext) {}

  resize(w: number, h: number): void {
    if (w === this.w && h === this.h) return
    this.dispose()
    this.w = w
    this.h = h
  }

  acquire(): Target {
    const t = this.free.pop()
    if (t) return t
    const created = createTarget(this.gl, this.w, this.h)
    this.all.push(created)
    return created
  }

  release(t: Target): void {
    this.free.push(t)
  }

  get size(): number {
    return this.all.length
  }

  dispose(): void {
    for (const t of this.all) deleteTarget(this.gl, t)
    this.all = []
    this.free = []
  }
}

/** Цвет `#rrggbb[aa]` → [r, g, b, a] 0..1. */
export function parseColor(hex: string): [number, number, number, number] {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})?$/i.exec(hex)
  if (!m) return [0, 0, 0, 1]
  const c = (s: string | undefined) => (s === undefined ? 1 : parseInt(s, 16) / 255)
  return [c(m[1]), c(m[2]), c(m[3]), c(m[4])]
}
