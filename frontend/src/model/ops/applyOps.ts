// Применение edit-ops (CONTRACT §6) одной атомарной транзакцией.
// Все примитивные ops и макро-ops applyEffectToMarkers / cutToMarkers / snapClipEdgesToMarkers (CONTRACT §6.2).
import { current, isDraft, produce, type Draft } from 'immer'
import type {
  Asset,
  Clip,
  ClipAnalysis,
  EditOp,
  EffectAnchor,
  EffectItem,
  Marker,
  MarkerFilter,
  MarkerInput,
  Project,
  RampKeyframe,
  Section,
  SectionInput,
  Track,
} from '@/shared/types.gen'
import { getEffectDef } from '@/shared/effects-registry'
import { isTempId, newId, type IdPrefix } from '@/shared/ids'
import { EPS, effectiveSourceOut, itemEnd } from '../clipTime'
import { splitClipData } from '../clipEdit'
import { syncAnchors } from '../anchors'
import { expandApplyEffectToMarkers } from '../applyEffectToMarkers'
import { expandCutToMarkers } from '../cutToMarkers'
import { checkInvariants } from '../invariants'
import { findClip, findEffect, findMarker, findTrack, collectIds, isClip, trackAcceptsAsset } from '../lookup'
import { finalizeProject } from '../project'
import { SECTION_LABELS, sectionListError } from '../sections'
import { expandSnapClipEdges } from '../snapClipEdges'
import { integral } from '../timeRemap'
import { OpsError } from './errors'

export { OpsError }

export interface ApplyContext {
  /** Метаданные ассета из библиотеки — копируются в project.assets при первом использовании. */
  resolveAsset?: (assetId: string) => Asset | undefined
  /** Генератор ID (в тестах — детерминированный). */
  newId?: (prefix: IdPrefix) => string
  /** Анализ клипа по ассету — для `cutToMarkers` с `order: "bestMoments"`. */
  clipAnalysis?: (assetId: string) => ClipAnalysis | undefined
}

export interface ApplyOutcome {
  /** tmp_ ID → настоящий. */
  idMap: Record<string, string>
  /** ID всех созданных сущностей (в порядке создания). */
  created: string[]
}

export const MACRO_OPS = ['applyEffectToMarkers', 'cutToMarkers', 'snapClipEdgesToMarkers'] as const

/**
 * Применяет ops к Immer-драфту проекта. Любая ошибка бросает OpsError — вызывающий
 * (produce / produceWithPatches) отбрасывает драфт, проект остаётся нетронутым.
 * В конце проверяются все инварианты CONTRACT §2.
 */
export function applyOpsToDraft(
  draft: Draft<Project>,
  ops: readonly EditOp[],
  ctx: ApplyContext = {},
): ApplyOutcome {
  const p = draft as Project
  const tx = new Tx(p, ctx)
  ops.forEach((op, i) => {
    try {
      tx.apply(op)
    } catch (e) {
      if (e instanceof OpsError) throw new OpsError(e.code, e.message, { opIndex: i, op, details: e.details })
      throw e
    }
  })
  syncAnchors(p, tx.touchedEffects)
  finalizeProject(p)
  const violations = checkInvariants(p)
  if (violations.length > 0) {
    throw new OpsError('invariant_violation', violations[0]!.message, {
      details: violations.map((v) => v.message),
    })
  }
  return { idMap: Object.fromEntries(tx.idMap), created: tx.created }
}

/** Чистая версия: возвращает новый проект (исходный не меняется) либо бросает OpsError. */
export function applyOps(
  project: Project,
  ops: readonly EditOp[],
  ctx: ApplyContext = {},
): { project: Project } & ApplyOutcome {
  let outcome: ApplyOutcome = { idMap: {}, created: [] }
  const next = produce(project, (d) => {
    outcome = applyOpsToDraft(d, ops, ctx)
  })
  return { project: next, ...outcome }
}

class Tx {
  readonly idMap = new Map<string, string>()
  readonly created: string[] = []
  /** Эффекты, созданные или изменённые напрямую: их место сохраняется, пересчитывается anchor.offset. */
  readonly touchedEffects = new Set<string>()
  private readonly ids: Set<string>
  private readonly gen: (prefix: IdPrefix) => string

  constructor(
    private readonly p: Project,
    private readonly ctx: ApplyContext,
  ) {
    this.ids = collectIds(p)
    this.gen = ctx.newId ?? ((prefix) => newId(prefix))
  }

  // --- ID ---

  /** Ссылка на сущность: tmp_ → настоящий ID (созданный ранее в этой транзакции). */
  ref(id: string): string {
    if (!isTempId(id)) return id
    const real = this.idMap.get(id)
    if (!real)
      throw new OpsError('unknown_temp_id', `Временный ID ${id} не был создан ранее в этом списке ops`)
    return real
  }

  /** ID для новой сущности: без id/с tmp_ — генерируется, иначе используется как есть (если свободен). */
  alloc(prefix: IdPrefix, requested?: string): string {
    let id: string
    if (requested && !isTempId(requested)) {
      if (!requested.startsWith(prefix + '_')) {
        throw new OpsError('bad_id', `ID ${requested} должен начинаться с ${prefix}_`)
      }
      id = requested
    } else {
      do id = this.gen(prefix)
      while (this.ids.has(id))
    }
    if (this.ids.has(id)) throw new OpsError('duplicate_id', `ID ${id} уже существует`)
    if (requested && isTempId(requested)) {
      if (this.idMap.has(requested))
        throw new OpsError('duplicate_id', `Временный ID ${requested} уже использован`)
      this.idMap.set(requested, id)
    }
    this.ids.add(id)
    this.created.push(id)
    return id
  }

  release(id: string): void {
    this.ids.delete(id)
  }

  // --- поиск ---

  track(trackId: string): Track {
    const t = findTrack(this.p, this.ref(trackId))
    if (!t) throw new OpsError('track_not_found', `Дорожка ${trackId} не найдена`)
    return t
  }

  clip(clipId: string): { track: Track; clip: Clip; index: number } {
    const c = findClip(this.p, this.ref(clipId))
    if (!c) throw new OpsError('clip_not_found', `Клип ${clipId} не найден`)
    return c
  }

  asset(assetId: string): Asset {
    const existing = this.p.assets.find((a) => a.id === assetId)
    if (existing) return existing
    const resolved = this.ctx.resolveAsset?.(assetId)
    if (!resolved) throw new OpsError('asset_not_found', `Ассет ${assetId} не найден`)
    const copy = structuredClone(resolved)
    this.p.assets.push(copy)
    return copy
  }

  // --- ops ---

  apply(op: EditOp): void {
    switch (op.op) {
      case 'addTrack':
        return this.addTrack(op.track, op.index)
      case 'removeTrack': {
        const t = this.track(op.trackId)
        this.p.tracks.splice(this.p.tracks.indexOf(t), 1)
        return
      }
      case 'updateTrack':
        return this.updateTrack(op.trackId, op.patch)
      case 'moveTrack':
        return this.moveTrack(op.trackId, op.index)
      case 'addClip':
        return this.addClip(op.trackId, op.clip)
      case 'updateClip':
        return this.updateClip(op.clipId, op.patch)
      case 'moveClip':
        return this.moveClip(op.clipId, op.start, op.trackId)
      case 'splitClip':
        return this.splitClip(op.clipId, op.at)
      case 'removeClip':
        return this.removeClip(op.clipId, op.ripple ?? false)
      case 'setTimeRemap':
        return this.setTimeRemap(op.clipId, op.timeRemap)
      case 'addMarkers':
        return this.addMarkers(op.target, op.markers)
      case 'updateMarker': {
        const ref = findMarker(this.p, this.ref(op.markerId))
        if (!ref) throw new OpsError('marker_not_found', `Маркер ${op.markerId} не найден`)
        assignDefined(ref.marker, op.patch)
        validateMarker(ref.marker)
        ref.list.sort(byT)
        return
      }
      case 'removeMarkers':
        for (const id of op.markerIds) {
          const ref = findMarker(this.p, this.ref(id))
          if (!ref) throw new OpsError('marker_not_found', `Маркер ${id} не найден`)
          ref.list.splice(ref.index, 1)
          this.release(ref.marker.id)
        }
        return
      case 'setSections':
        return this.setSections(op.target, op.sections)
      case 'addEffect':
        return this.addEffect(op.target, op.effect)
      case 'updateEffect': {
        const ref = findEffect(this.p, this.ref(op.effectId))
        if (!ref) throw new OpsError('effect_not_found', `Эффект ${op.effectId} не найден`)
        const { anchor, ...rest } = op.patch
        if (rest.effect !== undefined && !getEffectDef(rest.effect)) {
          throw new OpsError('unknown_effect', `Неизвестный эффект ${rest.effect}`)
        }
        assignDefined(ref.effect, rest)
        if (anchor !== undefined) ref.effect.anchor = this.anchor(anchor)
        if (rest.start !== undefined || anchor !== undefined) this.touchedEffects.add(ref.effect.id)
        return
      }
      case 'removeEffect': {
        const ref = findEffect(this.p, this.ref(op.effectId))
        if (!ref) throw new OpsError('effect_not_found', `Эффект ${op.effectId} не найден`)
        ref.list.splice(ref.index, 1)
        this.release(ref.effect.id)
        return
      }
      case 'cutToMarkers':
        return this.expand(
          expandCutToMarkers(
            this.snapshot(),
            {
              ...op,
              clipIds: op.clipIds.map((id) => this.ref(id)),
              filter: this.refFilter(op.filter),
              ...(op.trackId ? { trackId: this.ref(op.trackId) } : {}),
            },
            this.ctx,
          ),
        )
      case 'snapClipEdgesToMarkers':
        return this.expand(
          expandSnapClipEdges(this.snapshot(), {
            ...op,
            clipIds: op.clipIds.map((id) => this.ref(id)),
            filter: this.refFilter(op.filter),
          }),
        )
      case 'applyEffectToMarkers':
        return this.expand(
          expandApplyEffectToMarkers(this.snapshot(), {
            ...op,
            filter: this.refFilter(op.filter),
            target: typeof op.target === 'object' ? { trackId: this.ref(op.target.trackId) } : op.target,
          }),
        )
      default: {
        const unknown = op as { op?: unknown }
        throw new OpsError('unknown_op', `Неизвестный op ${String(unknown.op)}`)
      }
    }
  }

  private refFilter(f: MarkerFilter): MarkerFilter {
    return f.musicClipId ? { ...f, musicClipId: this.ref(f.musicClipId) } : f
  }

  /** Состояние проекта на момент макро-op (с учётом предыдущих ops списка). */
  private snapshot(): Project {
    return isDraft(this.p) ? current(this.p) : this.p
  }

  /** Макро-op раскрыт в примитивные ops — выполняем их в этой же транзакции. */
  private expand(ops: readonly EditOp[]): void {
    for (const op of ops) this.apply(op)
  }

  private addTrack(input: Extract<EditOp, { op: 'addTrack' }>['track'], index?: number): void {
    if (!['video', 'audio', 'fx'].includes(input.kind)) {
      throw new OpsError('bad_track_kind', `Неизвестный тип дорожки ${String(input.kind)}`)
    }
    const track: Track = {
      id: this.alloc('trk', input.id),
      kind: input.kind,
      name: input.name,
      muted: input.muted,
      locked: input.locked,
      hidden: input.hidden,
      items: [],
    }
    if (input.volume !== undefined) track.volume = input.volume
    const at = index === undefined ? this.p.tracks.length : Math.max(0, Math.min(index, this.p.tracks.length))
    this.p.tracks.splice(at, 0, track)
  }

  private updateTrack(trackId: string, patch: Extract<EditOp, { op: 'updateTrack' }>['patch']): void {
    const track = this.track(trackId)
    if (patch.name !== undefined && !(typeof patch.name === 'string' && patch.name.trim())) {
      throw new OpsError('bad_value', 'Имя дорожки не может быть пустым')
    }
    for (const flag of ['muted', 'locked', 'hidden'] as const) {
      if (patch[flag] !== undefined && typeof patch[flag] !== 'boolean') {
        throw new OpsError('bad_value', `${flag} должно быть boolean`)
      }
    }
    if (patch.volume !== undefined) {
      if (track.kind !== 'audio') throw new OpsError('bad_value', 'Громкость есть только у аудиодорожки')
      assertFinite(patch.volume, 'volume')
      if (patch.volume < 0 || patch.volume > 2) throw new OpsError('bad_value', 'volume вне 0..2')
    }
    assignDefined(track, patch)
  }

  /** Переставляет дорожку на позицию `index` итогового project.tracks (за пределами — к краю, как addTrack). */
  private moveTrack(trackId: string, index: number): void {
    const track = this.track(trackId)
    if (!Number.isInteger(index) || index < 0) throw new OpsError('bad_value', 'index должен быть целым ≥ 0')
    const from = this.p.tracks.indexOf(track)
    const to = Math.min(index, this.p.tracks.length - 1)
    if (from === to) return
    this.p.tracks.splice(from, 1)
    this.p.tracks.splice(to, 0, track)
  }

  private addClip(trackId: string, input: Extract<EditOp, { op: 'addClip' }>['clip']): void {
    const track = this.track(trackId)
    const asset = this.asset(input.assetId)
    if (!trackAcceptsAsset(track, asset.kind)) {
      throw new OpsError('incompatible_track', `Ассет ${asset.kind} нельзя положить на дорожку ${track.kind}`)
    }
    const { id: requested, ...rest } = structuredClone(input)
    const clip: Clip = { ...rest, id: this.alloc('clp', requested), type: 'clip' }
    clip.markers = clip.markers.map((m) => ({ ...m, id: this.alloc('mrk', m.id) }))
    if (clip.sections) clip.sections = this.sectionList(clip.sections)
    clip.effects = clip.effects.map((e) => this.effectItem(e))
    track.items.push(clip)
  }

  private updateClip(clipId: string, patch: Extract<EditOp, { op: 'updateClip' }>['patch']): void {
    const { clip, track } = this.clip(clipId)
    // CONTRACT §6.1 п. 9: маркеры и секции клипа меняются только marker-ops и setSections
    if ('markers' in patch || 'sections' in patch) {
      throw new OpsError(
        'bad_value',
        'updateClip не меняет markers/sections — используйте marker-ops и setSections',
      )
    }
    if (patch.assetId !== undefined) {
      const asset = this.asset(patch.assetId)
      if (!trackAcceptsAsset(track, asset.kind)) {
        throw new OpsError(
          'incompatible_track',
          `Ассет ${asset.kind} нельзя положить на дорожку ${track.kind}`,
        )
      }
    }
    assignDefined(clip, patch)
  }

  private moveClip(clipId: string, start: number, trackId?: string): void {
    const { clip, track, index } = this.clip(clipId)
    assertFinite(start, 'start')
    clip.start = start
    if (trackId === undefined) return
    const target = this.track(trackId)
    if (target === track) return
    if (target.kind !== track.kind) {
      throw new OpsError(
        'incompatible_track',
        `Нельзя перенести клип с дорожки ${track.kind} на ${target.kind}`,
      )
    }
    track.items.splice(index, 1)
    target.items.push(clip)
  }

  private splitClip(clipId: string, at: number): void {
    const { clip, track, index } = this.clip(clipId)
    assertFinite(at, 'at')
    if (!(at > clip.start + EPS && at < itemEnd(clip) - EPS)) {
      throw new OpsError('split_out_of_range', `Точка разреза ${at} вне клипа ${clip.id}`)
    }
    const plain: Clip = isDraft(clip) ? current(clip) : structuredClone(clip)
    const { left, right } = splitClipData(plain, at - clip.start, this.alloc('clp'), () => this.alloc('sec'))
    const moved = new Set(right.markers.map((m) => m.id))
    track.items.splice(index, 1, left, right)
    // эффекты, привязанные к ушедшим в правую половину маркерам, переадресуются
    for (const t of this.p.tracks) {
      for (const item of t.items) {
        const list = isClip(item) ? item.effects : [item]
        for (const e of list) {
          if (e.anchor?.clipId === clip.id && moved.has(e.anchor.markerId)) e.anchor.clipId = right.id
        }
      }
    }
  }

  private removeClip(clipId: string, ripple: boolean): void {
    const { clip, track, index } = this.clip(clipId)
    track.items.splice(index, 1)
    this.release(clip.id)
    if (!ripple) return
    const end = itemEnd(clip)
    for (const item of track.items) if (item.start >= end - EPS) item.start -= clip.duration
  }

  private setTimeRemap(clipId: string, remap: Extract<EditOp, { op: 'setTimeRemap' }>['timeRemap']): void {
    const { clip } = this.clip(clipId)
    if (remap === null) {
      // снимаем кривую, сохраняя слот и потребляемый диапазон: постоянная скорость
      const out = effectiveSourceOut(clip)
      delete clip.timeRemap
      clip.sourceOut = out
      clip.speed = (out - clip.sourceIn) / clip.duration
      return
    }
    validateKeyframes(remap.keyframes)
    clip.timeRemap = structuredClone(remap)
    if (remap.fit === 'free') clip.sourceOut = clip.sourceIn + clip.duration * integral(remap.keyframes, 1)
  }

  private addMarkers(target: Extract<EditOp, { op: 'addMarkers' }>['target'], markers: MarkerInput[]): void {
    const list: Marker[] = target === 'project' ? this.p.markers : this.clip(target.clipId).clip.markers
    for (const input of markers) {
      const { id: requested, ...rest } = input
      const m: Marker = { ...rest, id: this.alloc('mrk', requested) }
      validateMarker(m)
      list.push(m)
    }
    list.sort(byT)
  }

  /** Секции с проверкой и выделением ID (tmp_/без id → новые sec_). Список должен быть уже отсортирован. */
  private sectionList(input: readonly SectionInput[]): Section[] {
    const sorted = [...input].sort((a, b) => a.start - b.start)
    for (const s of sorted) {
      if (!SECTION_LABELS.includes(s.label))
        throw new OpsError('bad_value', `Неизвестная метка секции ${String(s.label)}`)
      if (!(Number.isFinite(s.energy) && s.energy >= 0 && s.energy <= 1))
        throw new OpsError('bad_value', 'energy секции вне 0..1')
    }
    const err = sectionListError(sorted)
    if (err) throw new OpsError('bad_value', err)
    return sorted.map((s) => {
      const { id: requested, ...rest } = structuredClone(s)
      return { ...rest, id: this.alloc('sec', requested) }
    })
  }

  /** CONTRACT §6.1 п. 9: заменяет весь список секций цели (source time для клипа, timeline time для проекта). */
  private setSections(target: Extract<EditOp, { op: 'setSections' }>['target'], input: SectionInput[]): void {
    let owner: { sections?: Section[] }
    let old: readonly Section[]
    if (target === 'project') {
      owner = this.p
      old = this.p.sections
    } else {
      const { clip, track } = this.clip(target.clipId)
      const asset = this.p.assets.find((a) => a.id === clip.assetId)
      if (track.kind !== 'audio' && !(track.kind === 'video' && asset?.hasAudio)) {
        throw new OpsError(
          'bad_value',
          'Секции музыки можно задать только аудиоклипу или видеоклипу со звуком',
        )
      }
      owner = clip
      old = clip.sections ?? []
    }
    // старые ID освобождаются, чтобы можно было сохранить их в новом списке
    for (const s of old) this.release(s.id)
    owner.sections = this.sectionList(input)
  }

  private addEffect(
    target: Extract<EditOp, { op: 'addEffect' }>['target'],
    input: Extract<EditOp, { op: 'addEffect' }>['effect'],
  ): void {
    const effect = this.effectItem(input)
    if ('trackId' in target) {
      const track = this.track(target.trackId)
      if (track.kind !== 'fx')
        throw new OpsError('incompatible_track', `Эффект можно положить только на fx-дорожку`)
      track.items.push(effect)
    } else {
      this.clip(target.clipId).clip.effects.push(effect)
    }
  }

  private effectItem(input: Omit<EffectItem, 'id' | 'type'> & { id?: string }): EffectItem {
    if (!getEffectDef(input.effect))
      throw new OpsError('unknown_effect', `Неизвестный эффект ${input.effect}`)
    const { id: requested, anchor, ...rest } = structuredClone(input)
    const effect: EffectItem = { ...rest, id: this.alloc('fx', requested), type: 'effect' }
    if (anchor) effect.anchor = this.anchor(anchor)
    this.touchedEffects.add(effect.id)
    return effect
  }

  private anchor(a: EffectAnchor): EffectAnchor {
    const res: EffectAnchor = { markerId: this.ref(a.markerId), offset: a.offset }
    if (!findMarker(this.p, res.markerId))
      throw new OpsError('marker_not_found', `Маркер ${a.markerId} не найден`)
    if (a.clipId !== undefined) {
      res.clipId = this.ref(a.clipId)
      if (!findClip(this.p, res.clipId)) throw new OpsError('clip_not_found', `Клип ${a.clipId} не найден`)
    }
    return res
  }
}

function byT(a: Marker, b: Marker): number {
  return a.t - b.t
}

function assertFinite(v: number, name: string): void {
  if (!Number.isFinite(v)) throw new OpsError('bad_value', `${name} должно быть конечным числом`)
}

function validateMarker(m: Marker): void {
  assertFinite(m.t, 't')
  if (m.t < 0) throw new OpsError('bad_value', `Маркер ${m.id}: t < 0`)
  if (!(m.strength >= 0 && m.strength <= 1))
    throw new OpsError('bad_value', `Маркер ${m.id}: strength вне 0..1`)
}

function validateKeyframes(keys: RampKeyframe[]): void {
  const first = keys[0]
  const last = keys[keys.length - 1]
  if (keys.length < 2 || !first || !last) throw new OpsError('bad_time_remap', 'Нужно минимум 2 ключа')
  if (first.u !== 0 || last.u !== 1) throw new OpsError('bad_time_remap', 'Первый ключ u=0, последний u=1')
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i]!
    if (!(k.speed > 0)) throw new OpsError('bad_time_remap', 'speed должна быть > 0')
    if (i > 0 && !(k.u > keys[i - 1]!.u)) throw new OpsError('bad_time_remap', 'u ключей должны возрастать')
  }
}

/** Object.assign без undefined-полей (патчи из JSON могут их не содержать, а из TS — содержать). */
function assignDefined<T extends object>(target: T, patch: Partial<T>): void {
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined) (target as Record<string, unknown>)[k] = structuredClone(v)
  }
}
