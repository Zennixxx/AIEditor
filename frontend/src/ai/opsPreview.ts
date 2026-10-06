// Предпросмотр ops от ИИ: сухой прогон на копии проекта, дифф для подсветки на таймлайне
// и описание изменений человеческим языком.
import { applyOps, OpsError, type ApplyContext } from '@/model/ops/applyOps'
import { getEffectDef } from '@/shared/effects-registry'
import type { EditOp, MarkerFilter, MarkerKind, Project } from '@/shared/types.gen'

export interface OpsPreview {
  /** Проект после ops; null — ops не применяются к текущему проекту. */
  project: Project | null
  /** Созданные элементы дорожек и дорожки — «призраки». */
  created: ReadonlySet<string>
  /** Изменённые существующие элементы и дорожки — фиолетовый контур. */
  changed: ReadonlySet<string>
  removed: readonly string[]
  lines: readonly string[]
  error: string | null
}

/** Снимок элементов: id → JSON (дорожки без items, элементы дорожек, эффекты клипов). */
function snapshot(p: Project): Map<string, string> {
  const out = new Map<string, string>()
  for (const track of p.tracks) {
    const { items: _items, ...rest } = track
    out.set(track.id, JSON.stringify(rest))
    for (const item of track.items) {
      out.set(item.id, JSON.stringify(item))
      if (item.type === 'clip') for (const fx of item.effects) out.set(fx.id, JSON.stringify(fx))
    }
  }
  return out
}

export function previewOps(project: Project, ops: readonly EditOp[], ctx: ApplyContext = {}): OpsPreview {
  const lines = describeOps(project, ops)
  try {
    const res = applyOps(project, ops, ctx)
    const before = snapshot(project)
    const after = snapshot(res.project)
    const created = new Set<string>()
    const changed = new Set<string>()
    for (const [id, json] of after) {
      const prev = before.get(id)
      if (prev === undefined) created.add(id)
      else if (prev !== json) changed.add(id)
    }
    const removed = [...before.keys()].filter((id) => !after.has(id))
    return { project: res.project, created, changed, removed, lines, error: null }
  } catch (e) {
    if (!(e instanceof OpsError)) throw e
    return { project: null, created: new Set(), changed: new Set(), removed: [], lines, error: e.message }
  }
}

const KIND_NAMES: Record<MarkerKind, string> = {
  bass: 'басы',
  beat: 'биты',
  downbeat: 'даунбиты',
  onset: 'онсеты',
  manual: 'ручные маркеры',
  ai: 'ИИ-маркеры',
}

const TRACK_KIND_NAMES = { video: 'видео', audio: 'аудио', fx: 'fx' } as const

const fmt = (t: number) => `${(Math.round(t * 100) / 100).toFixed(2)} с`

export function describeFilter(f: MarkerFilter): string {
  const parts = [(f.kinds ?? ['bass']).map((k) => KIND_NAMES[k]).join(', ')]
  if (f.minStrength) parts.push(`сила ≥ ${f.minStrength}`)
  if (f.every && f.every > 1) parts.push(`каждый ${f.every}-й${f.offset ? ` со сдвигом ${f.offset}` : ''}`)
  if (f.sectionLabels?.length) parts.push(`секции: ${f.sectionLabels.join(', ')}`)
  if (f.range) parts.push(`${fmt(f.range.start)}–${fmt(f.range.end)}`)
  return parts.join(', ')
}

const effectName = (id: string) => getEffectDef(id)?.name ?? id

/** Имена сущностей для описаний: из проекта и из tmp_-ID, созданных раньше в этом же списке. */
class Names {
  private readonly map = new Map<string, string>()

  constructor(p: Project) {
    const asset = (id: string) => p.assets.find((a) => a.id === id)?.name ?? id
    for (const t of p.tracks) {
      this.map.set(t.id, t.name)
      for (const item of t.items) {
        if (item.type === 'clip') {
          this.map.set(item.id, item.label ?? asset(item.assetId))
          for (const fx of item.effects) this.map.set(fx.id, effectName(fx.effect))
        } else {
          this.map.set(item.id, effectName(item.effect))
        }
      }
    }
  }

  set(id: string | undefined, name: string): void {
    if (id) this.map.set(id, name)
  }

  get(id: string): string {
    return this.map.get(id) ?? id
  }
}

interface Line {
  text: string
  /** Ключ группировки подряд идущих однотипных ops. */
  group?: string
}

const GROUP_TEXT: Record<string, (n: number) => string> = {
  addClip: (n) => `Добавить клипы: ${n}`,
  addEffect: (n) => `Добавить эффекты: ${n}`,
  removeClip: (n) => `Удалить клипы: ${n}`,
  removeEffect: (n) => `Удалить эффекты: ${n}`,
  setTimeRemap: (n) => `Speed ramp на клипах: ${n}`,
  updateClip: (n) => `Изменить клипы: ${n}`,
  moveClip: (n) => `Переместить клипы: ${n}`,
  updateEffect: (n) => `Изменить эффекты: ${n}`,
}

const GROUP_MIN = 4

function describeOne(op: EditOp, names: Names, p: Project): Line {
  switch (op.op) {
    case 'addTrack':
      names.set(op.track.id, op.track.name)
      return { text: `Новая ${TRACK_KIND_NAMES[op.track.kind]}-дорожка «${op.track.name}»` }
    case 'removeTrack':
      return { text: `Удалить дорожку «${names.get(op.trackId)}»` }
    case 'updateTrack':
      return { text: `Дорожка «${names.get(op.trackId)}»: ${Object.keys(op.patch).join(', ')}` }
    case 'moveTrack':
      return { text: `Переставить дорожку «${names.get(op.trackId)}»` }
    case 'addClip': {
      const name = op.clip.label ?? p.assets.find((a) => a.id === op.clip.assetId)?.name ?? op.clip.assetId
      names.set(op.clip.id, name)
      const ramp = op.clip.timeRemap ? ', ramp' : ''
      return {
        text: `Клип «${name}» на ${fmt(op.clip.start)} (${fmt(op.clip.duration)}${ramp}) → «${names.get(op.trackId)}»`,
        group: 'addClip',
      }
    }
    case 'updateClip':
      return {
        text: `Клип «${names.get(op.clipId)}»: ${Object.keys(op.patch).join(', ')}`,
        group: 'updateClip',
      }
    case 'moveClip':
      return { text: `Переместить «${names.get(op.clipId)}» на ${fmt(op.start)}`, group: 'moveClip' }
    case 'splitClip':
      return { text: `Разрезать «${names.get(op.clipId)}» на ${fmt(op.at)}` }
    case 'removeClip':
      return {
        text: `Удалить клип «${names.get(op.clipId)}»${op.ripple ? ' со сдвигом' : ''}`,
        group: 'removeClip',
      }
    case 'setTimeRemap':
      return {
        text: op.timeRemap
          ? `Speed ramp на «${names.get(op.clipId)}»`
          : `Снять speed ramp с «${names.get(op.clipId)}»`,
        group: 'setTimeRemap',
      }
    case 'addMarkers':
      return { text: `Добавить маркеры: ${op.markers.length}` }
    case 'updateMarker':
      return { text: 'Изменить маркер' }
    case 'removeMarkers':
      return { text: `Удалить маркеры: ${op.markerIds.length}` }
    case 'setSections':
      return {
        text: op.sections.length ? `Секции: ${op.sections.map((s) => s.label).join(' → ')}` : 'Убрать секции',
      }
    case 'addEffect': {
      const name = effectName(op.effect.effect)
      names.set(op.effect.id, name)
      const where = 'trackId' in op.target ? names.get(op.target.trackId) : names.get(op.target.clipId)
      return { text: `Эффект «${name}» на ${fmt(op.effect.start)} → «${where}»`, group: 'addEffect' }
    }
    case 'updateEffect':
      return { text: `Изменить эффект «${names.get(op.effectId)}»`, group: 'updateEffect' }
    case 'removeEffect':
      return { text: `Удалить эффект «${names.get(op.effectId)}»`, group: 'removeEffect' }
    case 'applyEffectToMarkers': {
      const target =
        op.target === 'newFxTrack'
          ? 'новая fx-дорожка'
          : op.target === 'clipsUnderMarker'
            ? 'клипы под маркерами'
            : `«${names.get(op.target.trackId)}»`
      const scaled = op.scaleByStrength ? ', сила по маркеру' : ''
      return {
        text: `«${effectName(op.effect)}» на маркеры (${describeFilter(op.filter)}${scaled}) → ${target}`,
      }
    }
    case 'cutToMarkers': {
      const order = { sequential: 'по порядку', random: 'случайно', bestMoments: 'лучшие моменты' }[op.order]
      return {
        text: `Нарезать клипы (${op.clipIds.length}) по маркерам (${describeFilter(op.filter)}), ${order}`,
      }
    }
    case 'snapClipEdgesToMarkers':
      return {
        text: `Подогнать края клипов (${op.clipIds.length}) к маркерам (${describeFilter(op.filter)}, до ${fmt(op.maxShift)})`,
      }
  }
}

export function describeOps(project: Project, ops: readonly EditOp[]): string[] {
  const names = new Names(project)
  const lines = ops.map((op) => describeOne(op, names, project))
  const out: string[] = []
  for (let i = 0; i < lines.length;) {
    const group = lines[i]!.group
    let j = i + 1
    while (group && j < lines.length && lines[j]!.group === group) j++
    const n = j - i
    if (group && n >= GROUP_MIN) out.push(GROUP_TEXT[group]!(n))
    else for (let k = i; k < j; k++) out.push(lines[k]!.text)
    i = j
  }
  return out
}
