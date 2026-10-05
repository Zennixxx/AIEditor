/* Сгенерировано из shared/schema командой `npm run gen:types`. Не редактировать вручную. */

export type EaseName = 'linear' | 'hold' | 'easeIn' | 'easeOut' | 'easeInOut'
/**
 * Интерполяция от ключа к следующему. easeIn=[0.42,0,1,1], easeOut=[0,0,0.58,1], easeInOut=[0.42,0,0.58,1].
 */
export type Ease = EaseName | BezierEase
/**
 * Число — константа; массив — ключевые кадры.
 */
export type Animatable = number | Keyframe[]
export type MarkerKind = 'bass' | 'beat' | 'downbeat' | 'onset' | 'manual' | 'ai'
export type SectionLabel = 'intro' | 'verse' | 'build' | 'drop' | 'break' | 'outro' | 'other'
export type EnvelopeCurve = 'linear' | 'exp' | 'easeOut'
export type TimeRemapFit = 'stretch' | 'free'
export type BlendMode = 'normal' | 'add' | 'screen' | 'multiply' | 'overlay'
export type TrackKind = 'video' | 'audio' | 'fx'
export type TrackItem = Clip | EffectItem
export type AssetKind = 'video' | 'audio' | 'image'
export type AssetStatus = 'importing' | 'ready' | 'failed'
export type ShotType = 'closeup' | 'medium' | 'wide' | 'other'
export type JobKind =
  | 'import'
  | 'proxy'
  | 'thumbs'
  | 'waveform'
  | 'mezzanine'
  | 'musicAnalysis'
  | 'stems'
  | 'interpolate'
  | 'clipAnalysis'
  | 'aiMusic'
  | 'autoEdit'
  | 'styleRef'
  | 'debug'
  | 'audio'
export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'canceled'
export type WsEvent = WsHello | WsJob | WsAsset
export type CutOrder = 'sequential' | 'random' | 'bestMoments'
export type EditOp =
  | OpAddTrack
  | OpRemoveTrack
  | OpAddClip
  | OpUpdateClip
  | OpMoveClip
  | OpSplitClip
  | OpRemoveClip
  | OpSetTimeRemap
  | OpAddMarkers
  | OpUpdateMarker
  | OpRemoveMarkers
  | OpAddEffect
  | OpUpdateEffect
  | OpRemoveEffect
  | OpApplyEffectToMarkers
  | OpCutToMarkers
  | OpSnapClipEdgesToMarkers
export type EffectCategory = 'camera' | 'light' | 'color' | 'distort' | 'stylize' | 'transition'
export type EffectParamType = 'number' | 'boolean' | 'color' | 'enum'

export interface BezierEase {
  /**
   * Как CSS cubic-bezier(x1, y1, x2, y2).
   *
   * @minItems 4
   * @maxItems 4
   */
  bezier: number[]
}
export interface Keyframe {
  /**
   * Время от начала клипа на таймлайне, сек.
   */
  t: number
  v: number
  ease: Ease
}
export interface Transform {
  x: Animatable
  y: Animatable
  scale: Animatable
  rotation: Animatable
  anchorX: number
  anchorY: number
}
export interface Marker {
  id: string
  /**
   * Source time (маркер клипа) или timeline time (маркер проекта).
   */
  t: number
  kind: MarkerKind
  strength: number
  label?: string
  color?: string
}
export interface Section {
  id: string
  start: number
  end: number
  label: SectionLabel
  energy: number
  description?: string
}
export interface Envelope {
  attack: number
  hold: number
  decay: number
  curve: EnvelopeCurve
}
export interface EffectAnchor {
  markerId: string
  clipId?: string
  offset: number
}
export interface EffectParams {
  [k: string]: number | string | boolean
}
export interface EffectItem {
  id: string
  type: 'effect'
  /**
   * id из shared/effects.json
   */
  effect: string
  /**
   * Timeline time (fx-дорожка) или время от начала клипа (clip.effects).
   */
  start: number
  duration: number
  params: EffectParams
  envelope: Envelope
  anchor?: EffectAnchor
  enabled: boolean
}
export interface RampKeyframe {
  u: number
  speed: number
  ease: Ease
}
export interface TimeRemap {
  /**
   * @minItems 2
   */
  keyframes: RampKeyframe[]
  fit: TimeRemapFit
  frameBlend: boolean
}
export interface Clip {
  id: string
  type: 'clip'
  assetId: string
  start: number
  duration: number
  sourceIn: number
  sourceOut: number
  speed: number
  reverse: boolean
  timeRemap?: TimeRemap
  transform: Transform
  opacity: Animatable
  blendMode: BlendMode
  volume?: Animatable
  effects: EffectItem[]
  markers: Marker[]
  interpolatedAssetId?: string
  label?: string
  color?: string
}
export interface Track {
  id: string
  kind: TrackKind
  name: string
  muted: boolean
  locked: boolean
  hidden: boolean
  volume?: number
  items: TrackItem[]
}
export interface AssetDerived {
  proxy?: string
  mezzanine?: string
  audio?: string
  thumbs?: string
  waveform?: string
}
export interface AssetParent {
  assetId: string
  kind: 'interpolated'
  factor: number
  sourceIn: number
  sourceOut: number
}
export interface Asset {
  id: string
  kind: AssetKind
  name: string
  path: string
  duration: number
  width?: number
  height?: number
  fps?: number
  hasAudio: boolean
  codec: string
  browserDecodable: boolean
  status: AssetStatus
  derived: AssetDerived
  parent?: AssetParent
}
export interface Project {
  schemaVersion: 1
  id: string
  name: string
  fps: 24 | 25 | 30 | 50 | 60
  width: number
  height: number
  duration: number
  background: string
  assets: Asset[]
  tracks: Track[]
  markers: Marker[]
  sections: Section[]
  createdAt: string
  updatedAt: string
  revision: number
}
export interface ApiErrorBody {
  code: string
  message: string
  details?: {}
}
export interface ApiError {
  error: ApiErrorBody
}
export interface Health {
  status: 'ok'
  version: string
  schemaVersion: number
  ffmpeg: boolean
  rife: boolean
  demucs: boolean
  gemini: boolean
}
export interface Thumbs {
  interval: number
  tileWidth: number
  tileHeight: number
  columns: number
  count: number
  sprites: string[]
}
export interface Waveform {
  sampleRate: number
  samplesPerPeak: number
  channels: 1
  /**
   * Пары [min, max, min, max, …], int8 −128..127.
   */
  peaks: number[]
}
export interface TimedStrength {
  t: number
  strength: number
}
export interface SectionSpan {
  start: number
  end: number
  label: SectionLabel
  energy: number
  description?: string
}
export interface Curve {
  /**
   * Шаг между значениями, сек.
   */
  interval: number
  values: number[]
}
export interface MusicAnalysisParams {
  bassCutoffHz: number
  sensitivity: number
  minGapSec: number
  useStems: boolean
}
/**
 * Частичные параметры для POST /analysis/music/{id}; недостающие берутся по умолчанию.
 */
export interface MusicAnalysisParamsInput {
  bassCutoffHz?: number
  sensitivity?: number
  minGapSec?: number
  useStems?: boolean
}
export interface Stems {
  drums?: string
  bass?: string
  other?: string
  vocals?: string
}
export interface MusicAnalysis {
  assetId: string
  params: MusicAnalysisParams
  bpm: number
  beats: number[]
  downbeats: number[]
  bass: TimedStrength[]
  onsets: TimedStrength[]
  sections: SectionSpan[]
  energy: Curve
  stems?: Stems
}
export interface Moment {
  start: number
  end: number
  score: number
  tags: string[]
  description: string
}
export interface Shot {
  start: number
  end: number
  type: ShotType
}
export interface ClipAnalysis {
  assetId: string
  /**
   * Модель Gemini; пустая строка, если анализ только локальный.
   */
  model: string
  summary: string
  moments: Moment[]
  shots: Shot[]
  motion: Curve
}
export interface ImportRequest {
  /**
   * @minItems 1
   */
  paths: string[]
}
export interface ImportResponse {
  assets: Asset[]
  jobs: JobRef[]
}
export interface JobRef {
  jobId: string
}
export interface InterpolateRequest {
  sourceIn: number
  sourceOut: number
  factor: 2 | 4 | 8 | 16
}
export interface AnalyzeClipRequest {
  force?: boolean
}
export interface ProjectListItem {
  id: string
  name: string
  updatedAt: string
}
export interface CreateProjectRequest {
  name: string
  fps: 24 | 25 | 30 | 50 | 60
  width: number
  height: number
}
/**
 * Эффект внутри пресета: start — относительно точки применения.
 */
export interface PresetEffect {
  effect: string
  start: number
  duration: number
  params: EffectParams
  envelope: Envelope
}
export interface EffectPreset {
  id: string
  name: string
  description?: string
  /**
   * @minItems 1
   */
  effects: PresetEffect[]
}
export interface Job {
  id: string
  kind: JobKind
  assetId?: string
  status: JobStatus
  progress: number
  message?: string
  /**
   * Тип зависит от kind (CONTRACT §8).
   */
  result?: unknown
  error?: ApiErrorBody
  createdAt: string
  updatedAt: string
}
export interface WsHello {
  type: 'hello'
  version: string
  schemaVersion: number
}
export interface WsJob {
  type: 'job'
  job: Job
}
export interface WsAsset {
  type: 'asset'
  asset: Asset
}
export interface TimeRange {
  start: number
  end: number
}
export interface MarkerFilter {
  /**
   * Чьи маркеры; по умолчанию — первый аудиоклип.
   */
  musicClipId?: string
  kinds?: MarkerKind[]
  minStrength?: number
  every?: number
  offset?: number
  sectionLabels?: SectionLabel[]
  range?: TimeRange
}
export interface ClipRef {
  clipId: string
}
export interface TrackRef {
  trackId: string
}
export interface TrackInput {
  id?: string
  kind: TrackKind
  name: string
  muted: boolean
  locked: boolean
  hidden: boolean
  volume?: number
}
export interface ClipInput {
  id?: string
  type: 'clip'
  assetId: string
  start: number
  duration: number
  sourceIn: number
  sourceOut: number
  speed: number
  reverse: boolean
  timeRemap?: TimeRemap
  transform: Transform
  opacity: Animatable
  blendMode: BlendMode
  volume?: Animatable
  effects: EffectItem[]
  markers: Marker[]
  interpolatedAssetId?: string
  label?: string
  color?: string
}
export interface ClipPatch {
  assetId?: string
  start?: number
  duration?: number
  sourceIn?: number
  sourceOut?: number
  speed?: number
  reverse?: boolean
  transform?: Transform
  opacity?: Animatable
  blendMode?: BlendMode
  volume?: Animatable
  interpolatedAssetId?: string
  label?: string
  color?: string
}
export interface MarkerInput {
  id?: string
  t: number
  kind: MarkerKind
  strength: number
  label?: string
  color?: string
}
export interface MarkerPatch {
  t?: number
  kind?: MarkerKind
  strength?: number
  label?: string
  color?: string
}
export interface EffectInput {
  id?: string
  effect: string
  start: number
  duration: number
  params: EffectParams
  envelope: Envelope
  anchor?: EffectAnchor
  enabled: boolean
}
export interface EffectPatch {
  effect?: string
  start?: number
  duration?: number
  params?: EffectParams
  envelope?: Envelope
  anchor?: EffectAnchor
  enabled?: boolean
}
export interface EnvelopePatch {
  attack?: number
  hold?: number
  decay?: number
  curve?: EnvelopeCurve
}
export interface OpAddTrack {
  op: 'addTrack'
  track: TrackInput
  index?: number
}
export interface OpRemoveTrack {
  op: 'removeTrack'
  trackId: string
}
export interface OpAddClip {
  op: 'addClip'
  trackId: string
  clip: ClipInput
}
export interface OpUpdateClip {
  op: 'updateClip'
  clipId: string
  patch: ClipPatch
}
export interface OpMoveClip {
  op: 'moveClip'
  clipId: string
  start: number
  trackId?: string
}
export interface OpSplitClip {
  op: 'splitClip'
  clipId: string
  /**
   * Timeline time.
   */
  at: number
}
export interface OpRemoveClip {
  op: 'removeClip'
  clipId: string
  ripple?: boolean
}
export interface OpSetTimeRemap {
  op: 'setTimeRemap'
  clipId: string
  timeRemap: TimeRemap | null
}
export interface OpAddMarkers {
  op: 'addMarkers'
  target: ClipRef | 'project'
  /**
   * @minItems 1
   */
  markers: MarkerInput[]
}
export interface OpUpdateMarker {
  op: 'updateMarker'
  markerId: string
  patch: MarkerPatch
}
export interface OpRemoveMarkers {
  op: 'removeMarkers'
  /**
   * @minItems 1
   */
  markerIds: string[]
}
export interface OpAddEffect {
  op: 'addEffect'
  target: TrackRef | ClipRef
  effect: EffectInput
}
export interface OpUpdateEffect {
  op: 'updateEffect'
  effectId: string
  patch: EffectPatch
}
export interface OpRemoveEffect {
  op: 'removeEffect'
  effectId: string
}
/**
 * Макро: раскрывается фронтом детерминированно в addEffect.
 */
export interface OpApplyEffectToMarkers {
  op: 'applyEffectToMarkers'
  effect: string
  params?: EffectParams
  envelope?: EnvelopePatch
  duration?: number
  /**
   * Сильнее на сильных маркерах.
   */
  scaleByStrength?: boolean
  filter: MarkerFilter
  target: TrackRef | ('newFxTrack' | 'clipsUnderMarker')
}
/**
 * Макро: раскладывает клипы по слотам между маркерами.
 */
export interface OpCutToMarkers {
  op: 'cutToMarkers'
  /**
   * @minItems 1
   */
  clipIds: string[]
  filter: MarkerFilter
  trackId?: string
  order: CutOrder
  /**
   * Для order=random — детерминированность.
   */
  seed?: number
}
export interface OpSnapClipEdgesToMarkers {
  op: 'snapClipEdgesToMarkers'
  /**
   * @minItems 1
   */
  clipIds: string[]
  filter: MarkerFilter
  maxShift: number
}
export interface OpsResult {
  ops: EditOp[]
  explanation: string
  warnings?: string[]
}
export interface Selection {
  clipIds: string[]
  markerIds: string[]
  effectIds: string[]
}
export interface ChatTurn {
  role: 'user' | 'assistant'
  text: string
}
export interface AICommandRequest {
  project: Project
  selection: Selection
  playhead: number
  message: string
  /**
   * @maxItems 10
   */
  history?: ChatTurn[]
}
export interface AutoEditRequest {
  project: Project
  musicClipId: string
  /**
   * @minItems 1
   */
  assetIds: string[]
  /**
   * id из shared/styles.json или "custom".
   */
  style: string
  customStyle?: StylePreset
  range?: TimeRange
  intensity: number
}
export interface StylePreset {
  id: string
  name: string
  description?: string
  cutDensity: CutDensityMap
  effects: StyleEffectRule[]
  /**
   * Эффекты на весь диапазон эдита (зерно, леттербокс, виньетка) — кладутся на fx-дорожку одним элементом.
   */
  globalEffects?: StyleGlobalEffect[]
  ramps: StyleRampRule[]
  transitions: StyleTransitionRule[]
  notes?: string
}
export interface CutDensityMap {
  intro: CutDensity
  verse: CutDensity
  build: CutDensity
  drop: CutDensity
  break: CutDensity
  outro: CutDensity
  other: CutDensity
}
export interface CutDensity {
  /**
   * @minItems 1
   */
  kinds: MarkerKind[]
  every: number
  minStrength: number
}
export interface StyleEffectRule {
  effect: string
  params: EffectParams
  filter: MarkerFilter
  probability: number
}
export interface StyleGlobalEffect {
  effect: string
  params: EffectParams
}
export interface StyleRampRule {
  /**
   * id из shared/fixtures/ramp_presets.json
   */
  preset: string
  where: 'drop-entry' | 'section-end' | 'random'
  probability: number
}
export interface StyleTransitionRule {
  effect: string
  at: 'section-boundary' | 'downbeat'
  probability: number
}
export interface StylesFile {
  version: number
  styles: StylePreset[]
}
export interface RampPreset {
  id: string
  name: string
  description: string
  timeRemap: TimeRemap
}
export interface RampPresetsFile {
  version: number
  presets: RampPreset[]
}
export interface EffectParamDef {
  key: string
  label: string
  type: EffectParamType
  default: number | string | boolean
  min?: number
  max?: number
  step?: number
  unit?: 'px' | 'deg' | 'x' | 'Hz' | 's' | '%'
  options?: string[]
}
export interface EffectDef {
  id: string
  name: string
  category: EffectCategory
  defaultDuration: number
  defaultEnvelope: Envelope
  params: EffectParamDef[]
  aiHint: string
}
export interface EffectsRegistry {
  version: number
  effects: EffectDef[]
}
export interface AiCommandFixture {
  id: string
  message: string
  selection?: Selection
  playhead?: number
  /**
   * Типы ops, которые должны присутствовать в ответе (порядок не важен).
   */
  expectedOps: string[]
  notes?: string
}
export interface AiCommandsFile {
  version: number
  projectFixture: string
  commands: AiCommandFixture[]
}
export interface TimeRemapVectorSample {
  tau: number
  src: number
}
export interface TimeRemapVector {
  name: string
  remap: TimeRemap
  D: number
  sourceIn: number
  /**
   * Для fit=free — ожидаемое вычисленное значение.
   */
  sourceOut: number
  reverse: boolean
  samples: TimeRemapVectorSample[]
}
export interface TimeRemapVectorsFile {
  version: number
  tolerance: number
  vectors: TimeRemapVector[]
}
