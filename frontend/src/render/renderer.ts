// WebGL2-рендерер кадра (FRONTEND.md §4.1): общий для превью и экспорта.
//
// Аккумулятор (непрозрачный, цвет фона) ← слои снизу вверх: кадр клипа → transform → эффекты клипа →
// смешение по blendMode/opacity; эффекты fx-дорожки применяются к аккумулятору. Промежуточные кадры —
// в премультиплицированной альфе, цели берутся из пула (без аллокаций GL после прогрева).
import { EFFECT_MODULES, type EffectFrame, type EffectModule } from './effects'
import type { EffectPass, FramePlan, LayerStep } from './framePlan'
import type { FrameImage, FrameResolver, FrameSourceKind } from './frameSource'
import { createTexture, FRAGMENT_HEADER, parseColor, Program, TargetPool, type Target } from './gl'
import { layerUvMatrix } from './layerMath'

const LAYER_FS = `${FRAGMENT_HEADER}
uniform mat3 u_map;   // пиксель цели → uv слоя
uniform vec4 u_crop;  // область источника в uv: xy — начало, zw — размер
void main() {
  vec2 uv = (u_map * vec3(v_uv * u_res, 1.0)).xy;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) { o_color = vec4(0.0); return; }
  o_color = texture(u_tex, u_crop.xy + uv * u_crop.zw);
}`

const COMPOSITE_FS = `${FRAGMENT_HEADER}
uniform sampler2D u_layer;
uniform float u_opacity;
uniform float u_mode; // 0 normal, 1 add, 2 screen, 3 multiply, 4 overlay
void main() {
  vec4 b = texture(u_tex, v_uv);
  vec4 s = texture(u_layer, v_uv) * u_opacity;
  vec3 rgb;
  if (u_mode < 0.5) rgb = s.rgb + b.rgb * (1.0 - s.a);
  else if (u_mode < 1.5) rgb = b.rgb + s.rgb;
  else if (u_mode < 2.5) rgb = b.rgb + s.rgb - b.rgb * s.rgb;
  else if (u_mode < 3.5) rgb = b.rgb * (s.rgb + 1.0 - s.a);
  else {
    vec3 l = s.a > 0.0 ? s.rgb / s.a : vec3(0.0);
    vec3 o = mix(2.0 * b.rgb * l, 1.0 - 2.0 * (1.0 - b.rgb) * (1.0 - l), step(0.5, b.rgb));
    rgb = mix(b.rgb, o, s.a);
  }
  o_color = vec4(clamp(rgb, 0.0, 1.0), 1.0);
}`

const BLIT_FS = `${FRAGMENT_HEADER}
void main() {
  // цели хранят кадр сверху вниз, экран — снизу вверх
  o_color = vec4(texture(u_tex, vec2(v_uv.x, 1.0 - v_uv.y)).rgb, 1.0);
}`

const BLEND_MODES: Record<LayerStep['blendMode'], number> = {
  normal: 0,
  add: 1,
  screen: 2,
  multiply: 3,
  overlay: 4,
}

/** Сколько рендеров текстура источника живёт без использования. */
const TEXTURE_TTL = 120

interface SourceTexture {
  tex: WebGLTexture
  lastUsed: number
  uploaded: boolean
}

export interface RenderStats {
  /** Источник кадра верхнего слоя (для отладки и e2e). */
  source: FrameSourceKind | 'none'
  clipId: string | null
  layers: number
  effects: number
}

export class Renderer {
  readonly gl: WebGL2RenderingContext
  private readonly pool: TargetPool
  private readonly layerProgram: Program
  private readonly compositeProgram: Program
  private readonly blitProgram: Program
  private readonly effectPrograms = new Map<string, Program | null>()
  private readonly sources = new Map<TexImageSource, SourceTexture>()
  private readonly vao: WebGLVertexArrayObject
  private tick = 0

  /** Бросает, если WebGL2 недоступен. */
  constructor(readonly canvas: HTMLCanvasElement | OffscreenCanvas) {
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: true,
      preserveDrawingBuffer: false,
    }) as WebGL2RenderingContext | null
    if (!gl) throw new Error('WebGL2 недоступен')
    this.gl = gl
    this.pool = new TargetPool(gl)
    this.layerProgram = new Program(gl, LAYER_FS, 'layer')
    this.compositeProgram = new Program(gl, COMPOSITE_FS, 'composite')
    this.blitProgram = new Program(gl, BLIT_FS, 'blit')
    this.vao = gl.createVertexArray()
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true)
    gl.disable(gl.BLEND)
    gl.disable(gl.DEPTH_TEST)
  }

  /** Компилирует шейдеры всех эффектов заранее (первое появление эффекта не даёт рывка). */
  warmUp(): void {
    for (const id of EFFECT_MODULES.keys()) this.effectProgram(id)
  }

  private effectProgram(id: string): Program | null {
    if (this.effectPrograms.has(id)) return this.effectPrograms.get(id)!
    const mod = EFFECT_MODULES.get(id)
    let program: Program | null = null
    if (mod) {
      try {
        program = new Program(this.gl, FRAGMENT_HEADER + mod.fragment, `effect:${id}`)
      } catch (e) {
        console.error(e)
      }
    }
    this.effectPrograms.set(id, program)
    return program
  }

  /** Рендер кадра плана в буфер canvas текущего размера. */
  render(plan: FramePlan, resolve: FrameResolver): RenderStats {
    const gl = this.gl
    const stats: RenderStats = { source: 'none', clipId: null, layers: 0, effects: 0 }
    if (gl.isContextLost()) return stats
    this.tick++
    const W = this.canvas.width
    const H = this.canvas.height
    this.pool.resize(W, H)
    const px = W / plan.width
    gl.bindVertexArray(this.vao)
    gl.viewport(0, 0, W, H)

    let acc = this.pool.acquire()
    const [br, bg, bb] = parseColor(plan.background || '#000000')
    gl.bindFramebuffer(gl.FRAMEBUFFER, acc.fbo)
    gl.clearColor(br, bg, bb, 1)
    gl.clear(gl.COLOR_BUFFER_BIT)

    for (const step of plan.steps) {
      if (step.kind === 'layer') {
        const image = resolve(step)
        if (!image) continue
        let layer = this.drawLayer(step, image, W, H)
        for (const pass of step.effects) {
          const out = this.applyEffect(pass, layer, plan, px)
          if (out) {
            this.pool.release(layer)
            layer = out
            stats.effects++
          }
        }
        const out = this.pool.acquire()
        this.compositeProgram.use()
        this.bindTexture(0, acc.tex)
        this.bindTexture(1, layer.tex)
        this.compositeProgram
          .setInt('u_tex', 0)
          .setInt('u_layer', 1)
          .set('u_res', [W, H])
          .set('u_opacity', step.opacity)
          .set('u_mode', BLEND_MODES[step.blendMode] ?? 0)
        this.draw(out)
        this.pool.release(acc)
        this.pool.release(layer)
        acc = out
        stats.layers++
        stats.source = image.kind
        stats.clipId = step.clip.id
      } else {
        for (const pass of step.effects) {
          const out = this.applyEffect(pass, acc, plan, px)
          if (out) {
            this.pool.release(acc)
            acc = out
            stats.effects++
          }
        }
      }
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.viewport(0, 0, W, H)
    this.blitProgram.use()
    this.bindTexture(0, acc.tex)
    this.blitProgram.setInt('u_tex', 0).set('u_res', [W, H])
    gl.drawArrays(gl.TRIANGLES, 0, 3)
    this.pool.release(acc)
    this.collectSources()
    return stats
  }

  private drawLayer(step: LayerStep, image: FrameImage, W: number, H: number): Target {
    const crop = image.crop ?? { x: 0, y: 0, w: image.width, h: image.height }
    const target = this.pool.acquire()
    this.layerProgram.use()
    this.bindTexture(0, this.sourceTexture(image))
    this.layerProgram
      .setInt('u_tex', 0)
      .set('u_res', [W, H])
      .setMat3('u_map', layerUvMatrix(W, H, crop.w, crop.h, step.transform))
      .set('u_crop', [
        crop.x / image.width,
        crop.y / image.height,
        crop.w / image.width,
        crop.h / image.height,
      ])
    this.draw(target)
    return target
  }

  /** Эффект `pass` над `input` в новую цель; null — у эффекта нет шейдера (кадр не меняется). */
  private applyEffect(pass: EffectPass, input: Target, plan: FramePlan, px: number): Target | null {
    const program = this.effectProgram(pass.item.effect)
    const mod = EFFECT_MODULES.get(pass.item.effect) as EffectModule
    if (!program) return null
    const frame: EffectFrame = { pass, fps: plan.fps, frame: plan.frame, res: [input.w, input.h], px }
    const out = this.pool.acquire()
    program.use()
    this.bindTexture(0, input.tex)
    program
      .setInt('u_tex', 0)
      .set('u_res', [input.w, input.h])
      .set('u_intensity', pass.intensity)
      .set('u_time', pass.tau)
      .set('u_seed', pass.seed)
      .set('u_frame', plan.frame)
      .set('u_px', px)
    const uniforms = mod.uniforms?.(frame)
    if (uniforms) for (const name in uniforms) program.set(name, uniforms[name]!)
    this.draw(out)
    return out
  }

  private draw(target: Target): void {
    const gl = this.gl
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo)
    gl.viewport(0, 0, target.w, target.h)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }

  private bindTexture(unit: number, tex: WebGLTexture): void {
    const gl = this.gl
    gl.activeTexture(gl.TEXTURE0 + unit)
    gl.bindTexture(gl.TEXTURE_2D, tex)
  }

  private sourceTexture(image: FrameImage): WebGLTexture {
    const gl = this.gl
    let entry = this.sources.get(image.source)
    if (!entry) {
      entry = { tex: createTexture(gl), lastUsed: this.tick, uploaded: false }
      this.sources.set(image.source, entry)
    }
    entry.lastUsed = this.tick
    if (image.dynamic || !entry.uploaded) {
      gl.bindTexture(gl.TEXTURE_2D, entry.tex)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image.source)
      entry.uploaded = true
    }
    return entry.tex
  }

  private collectSources(): void {
    for (const [source, entry] of this.sources) {
      if (this.tick - entry.lastUsed > TEXTURE_TTL) {
        this.gl.deleteTexture(entry.tex)
        this.sources.delete(source)
      }
    }
  }

  /** Сколько целей держит пул (для тестов «нет аллокаций в кадре»). */
  get targetCount(): number {
    return this.pool.size
  }

  dispose(): void {
    const gl = this.gl
    this.pool.dispose()
    for (const e of this.sources.values()) gl.deleteTexture(e.tex)
    this.sources.clear()
    for (const p of this.effectPrograms.values()) p?.dispose()
    this.layerProgram.dispose()
    this.compositeProgram.dispose()
    this.blitProgram.dispose()
    gl.deleteVertexArray(this.vao)
  }
}
