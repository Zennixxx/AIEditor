# Сгенерировано из shared/schema командой `uv run gen-models`. Не редактировать вручную.

from __future__ import annotations

from typing import Annotated, Any, Literal

from pydantic.alias_generators import to_camel
from pydantic import AwareDatetime, BaseModel, ConfigDict, Field

type AIEditorSchema = Annotated[Any, Field(..., title="AIEditorSchema")]


type EaseName = Literal["linear", "hold", "easeIn", "easeOut", "easeInOut"]


class BezierEase(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
        alias_generator=to_camel,
    )
    bezier: list[float] = Field(
        ..., description="Как CSS cubic-bezier(x1, y1, x2, y2).", max_length=4, min_length=4
    )


type Ease = Annotated[
    EaseName | BezierEase,
    Field(
        ...,
        description="Интерполяция от ключа к следующему. easeIn=[0.42,0,1,1], easeOut=[0,0,0.58,1], easeInOut=[0.42,0,0.58,1].",
    ),
]


class Keyframe(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
        alias_generator=to_camel,
    )
    t: float = Field(..., description="Время от начала клипа на таймлайне, сек.")
    v: float
    ease: Ease


type Animatable1 = Annotated[
    list[Keyframe], Field(..., description="Число — константа; массив — ключевые кадры.", min_length=1)
]


type Animatable = Annotated[
    float | Animatable1, Field(..., description="Число — константа; массив — ключевые кадры.")
]


class Transform(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
        alias_generator=to_camel,
    )
    x: Animatable
    y: Animatable
    scale: Animatable
    rotation: Animatable
    anchor_x: float = Field(...)
    anchor_y: float = Field(...)


type MarkerKind = Literal["bass", "beat", "downbeat", "onset", "manual", "ai"]


class Marker(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
        alias_generator=to_camel,
    )
    id: str = Field(..., pattern="^(mrk|tmp)_")
    t: float = Field(..., description="Source time (маркер клипа) или timeline time (маркер проекта).")
    kind: MarkerKind
    strength: float = Field(..., ge=0.0, le=1.0)
    label: str | None = None
    color: str | None = None


type SectionLabel = Literal["intro", "verse", "build", "drop", "break", "outro", "other"]


class Section(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
        alias_generator=to_camel,
    )
    id: str = Field(..., pattern="^(sec|tmp)_")
    start: float
    end: float
    label: SectionLabel
    energy: float = Field(..., ge=0.0, le=1.0)
    description: str | None = None


type EnvelopeCurve = Literal["linear", "exp", "easeOut"]


class Envelope(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
        alias_generator=to_camel,
    )
    attack: float = Field(..., ge=0.0)
    hold: float = Field(..., ge=0.0)
    decay: float = Field(..., ge=0.0)
    curve: EnvelopeCurve


class EffectAnchor(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
        alias_generator=to_camel,
    )
    marker_id: str = Field(...)
    clip_id: str | None = Field(None)
    offset: float


type EffectParams = dict[str, float | str | bool]


class EffectItem(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
        alias_generator=to_camel,
    )
    id: str = Field(..., pattern="^(fx|tmp)_")
    type: Literal["effect"] = "effect"
    effect: str = Field(..., description="id из shared/effects.json")
    start: float = Field(
        ..., description="Timeline time (fx-дорожка) или время от начала клипа (clip.effects)."
    )
    duration: float = Field(..., gt=0.0)
    params: EffectParams
    envelope: Envelope
    anchor: EffectAnchor | None = None
    enabled: bool


class RampKeyframe(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
        alias_generator=to_camel,
    )
    u: float = Field(..., ge=0.0, le=1.0)
    speed: float = Field(..., gt=0.0)
    ease: Ease


type TimeRemapFit = Literal["stretch", "free"]


class TimeRemap(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
        alias_generator=to_camel,
    )
    keyframes: list[RampKeyframe] = Field(..., min_length=2)
    fit: TimeRemapFit
    frame_blend: bool = Field(...)


type BlendMode = Literal["normal", "add", "screen", "multiply", "overlay"]


class Clip(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
        alias_generator=to_camel,
    )
    id: str = Field(..., pattern="^(clp|tmp)_")
    type: Literal["clip"] = "clip"
    asset_id: str = Field(...)
    start: float = Field(..., ge=0.0)
    duration: float = Field(..., gt=0.0)
    source_in: float = Field(..., ge=0.0)
    source_out: float = Field(..., gt=0.0)
    speed: float = Field(..., gt=0.0)
    reverse: bool
    time_remap: TimeRemap | None = Field(None)
    transform: Transform
    opacity: Animatable
    blend_mode: BlendMode = Field(...)
    volume: Animatable | None = None
    effects: list[EffectItem]
    markers: list[Marker]
    sections: list[Section] | None = Field(
        None,
        description="Секции музыки в SOURCE time (из анализа), двигаются вместе с клипом. Только у audio-клипов и видеоклипов со звуком.",
    )
    interpolated_asset_id: str | None = Field(None)
    label: str | None = None
    color: str | None = None


type TrackKind = Literal["video", "audio", "fx"]


type TrackItem = Clip | EffectItem


class Track(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
        alias_generator=to_camel,
    )
    id: str = Field(..., pattern="^(trk|tmp)_")
    kind: TrackKind
    name: str
    muted: bool
    locked: bool
    hidden: bool
    volume: float | None = Field(None, ge=0.0, le=2.0)
    items: list[TrackItem]


type AssetKind = Literal["video", "audio", "image"]


type AssetStatus = Literal["importing", "ready", "failed"]


class AssetDerived(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
        alias_generator=to_camel,
    )
    proxy: str | None = None
    mezzanine: str | None = None
    audio: str | None = None
    thumbs: str | None = None
    waveform: str | None = None


class AssetParent(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
        alias_generator=to_camel,
    )
    asset_id: str = Field(...)
    kind: Literal["interpolated"] = "interpolated"
    factor: int = Field(..., ge=2)
    source_in: float = Field(...)
    source_out: float = Field(...)
    quality: Literal["rife", "fallback"] | None = None


class Asset(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
        alias_generator=to_camel,
    )
    id: str = Field(..., pattern="^ast_")
    kind: AssetKind
    name: str
    path: str
    duration: float = Field(..., ge=0.0)
    width: int | None = None
    height: int | None = None
    fps: float | None = None
    has_audio: bool = Field(...)
    codec: str
    browser_decodable: bool = Field(...)
    status: AssetStatus
    derived: AssetDerived
    parent: AssetParent | None = None


class Project(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
        alias_generator=to_camel,
    )
    schema_version: Literal[1] = Field(1)
    id: str = Field(..., pattern="^prj_")
    name: str
    fps: Literal[24, 25, 30, 50, 60]
    width: int = Field(..., ge=16)
    height: int = Field(..., ge=16)
    duration: float = Field(..., ge=0.0)
    background: str
    assets: list[Asset]
    tracks: list[Track]
    markers: list[Marker]
    sections: list[Section] = Field(
        ...,
        description="Секции композиции в timeline time (ручные / ИИ). Секции из анализа музыки живут в clip.sections.",
    )
    created_at: AwareDatetime = Field(...)
    updated_at: AwareDatetime = Field(...)
    revision: int = Field(..., ge=0)


class ApiErrorBody(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
        alias_generator=to_camel,
    )
    code: str
    message: str
    details: dict[str, Any] | None = None


class ApiError(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
        alias_generator=to_camel,
    )
    error: ApiErrorBody


class DiskInfo(BaseModel):
    """
    Диск каталога данных бэка.
    """

    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
        alias_generator=to_camel,
    )
    path: str = Field(..., description="абсолютный путь каталога данных")
    free: int = Field(..., description="свободно, байт", ge=0)
    total: int = Field(..., description="всего, байт", ge=0)


class CacheCleanupResult(BaseModel):
    """
    Ответ DELETE /cache (CONTRACT §8.8).
    """

    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
        alias_generator=to_camel,
    )
    removed_assets: list[str] = Field(..., description="id удалённых ассетов (исходных и производных)")
    gemini_files: int = Field(..., description="удалено записей кэша ответов Gemini", ge=0)
    freed_bytes: int = Field(..., ge=0)


class Thumbs(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
        alias_generator=to_camel,
    )
    interval: float
    tile_width: int = Field(...)
    tile_height: int = Field(...)
    columns: int
    rows: int | None = Field(None, description="строк плиток в одном атласе; по умолчанию = columns", ge=1)
    count: int
    sprites: list[str]


type Peak = Annotated[int, Field(..., ge=-128, le=127)]


class Waveform(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
        alias_generator=to_camel,
    )
    sample_rate: int = Field(...)
    samples_per_peak: int = Field(...)
    channels: Literal[1] = 1
    peaks: list[Peak] = Field(..., description="Пары [min, max, min, max, …], int8 −128..127.")


class TimedStrength(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
        alias_generator=to_camel,
    )
    t: float
    strength: float = Field(..., ge=0.0, le=1.0)


class SectionSpan(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
        alias_generator=to_camel,
    )
    start: float
    end: float
    label: SectionLabel
    energy: float = Field(..., ge=0.0, le=1.0)
    description: str | None = None


class Curve(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
        alias_generator=to_camel,
    )
    interval: float = Field(..., description="Шаг между значениями, сек.")
    values: list[float]


class MusicAnalysisParams(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
        alias_generator=to_camel,
    )
    bass_cutoff_hz: float = Field(..., ge=20.0, le=1000.0)
    sensitivity: float = Field(..., ge=0.0, le=1.0)
    min_gap_sec: float = Field(..., ge=0.01, le=2.0)
    use_stems: bool = Field(...)


class MusicAnalysisParamsInput(BaseModel):
    """
    Частичные параметры для POST /analysis/music/{id}; недостающие берутся по умолчанию.
    """

    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
        alias_generator=to_camel,
    )
    bass_cutoff_hz: float | None = Field(None, ge=20.0, le=1000.0)
    sensitivity: float | None = Field(None, ge=0.0, le=1.0)
    min_gap_sec: float | None = Field(None, ge=0.01, le=2.0)
    use_stems: bool | None = Field(None)


class Stems(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
        alias_generator=to_camel,
    )
    drums: str | None = None
    bass: str | None = None
    other: str | None = None
    vocals: str | None = None


class MusicAnalysis(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
        alias_generator=to_camel,
    )
    asset_id: str = Field(...)
    params: MusicAnalysisParams
    bpm: float
    beats: list[float]
    downbeats: list[float]
    bass: list[TimedStrength]
    onsets: list[TimedStrength]
    sections: list[SectionSpan]
    energy: Curve
    stems: Stems | None = None


class Moment(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
        alias_generator=to_camel,
    )
    start: float
    end: float
    score: float = Field(..., ge=0.0, le=1.0)
    tags: list[str]
    description: str


type ShotType = Literal["closeup", "medium", "wide", "other"]


class Shot(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
        alias_generator=to_camel,
    )
    start: float
    end: float
    type: ShotType


class ClipAnalysis(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
        alias_generator=to_camel,
    )
    asset_id: str = Field(...)
    model: str = Field(..., description="Модель Gemini; пустая строка, если анализ только локальный.")
    summary: str
    moments: list[Moment]
    shots: list[Shot]
    motion: Curve


class ImportRequest(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
        alias_generator=to_camel,
    )
    paths: list[str] = Field(..., min_length=1)


class InterpolateRequest(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
        alias_generator=to_camel,
    )
    source_in: float = Field(..., ge=0.0)
    source_out: float = Field(..., gt=0.0)
    factor: Literal[2, 4, 8, 16]


class AnalyzeClipRequest(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
        alias_generator=to_camel,
    )
    force: bool | None = None


class ProjectListItem(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
        alias_generator=to_camel,
    )
    id: str
    name: str
    updated_at: AwareDatetime = Field(...)


class CreateProjectRequest(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
        alias_generator=to_camel,
    )
    name: str
    fps: Literal[24, 25, 30, 50, 60]
    width: int = Field(..., ge=16)
    height: int = Field(..., ge=16)


class PresetEffect(BaseModel):
    """
    Эффект внутри пресета: start — относительно точки применения.
    """

    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
        alias_generator=to_camel,
    )
    effect: str
    start: float
    duration: float = Field(..., gt=0.0)
    params: EffectParams
    envelope: Envelope


class CreateEffectPresetRequest(BaseModel):
    """
    Тело POST /presets: id назначает бэк (pst_).
    """

    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
        alias_generator=to_camel,
    )
    name: str = Field(..., min_length=1)
    description: str | None = None
    effects: list[PresetEffect] = Field(..., min_length=1)


class EffectPreset(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
        alias_generator=to_camel,
    )
    id: str
    name: str
    description: str | None = None
    effects: list[PresetEffect] = Field(..., min_length=1)


type JobKind = Literal[
    "import",
    "proxy",
    "thumbs",
    "waveform",
    "mezzanine",
    "musicAnalysis",
    "stems",
    "interpolate",
    "clipAnalysis",
    "aiMusic",
    "autoEdit",
    "styleRef",
    "debug",
    "audio",
]


type JobStatus = Literal["queued", "running", "done", "failed", "canceled"]


class JobRef(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
        alias_generator=to_camel,
    )
    job_id: str = Field(...)


class Job(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
        alias_generator=to_camel,
    )
    id: str = Field(..., pattern="^job_")
    kind: JobKind
    asset_id: str | None = Field(None)
    status: JobStatus
    progress: float = Field(..., ge=0.0, le=1.0)
    message: str | None = None
    result: Any | None = Field(None, description="Тип зависит от kind (CONTRACT §8).")
    error: ApiErrorBody | None = None
    created_at: AwareDatetime = Field(...)
    updated_at: AwareDatetime = Field(...)


class WsHello(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
        alias_generator=to_camel,
    )
    type: Literal["hello"] = "hello"
    version: str
    schema_version: int = Field(...)


class WsJob(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
        alias_generator=to_camel,
    )
    type: Literal["job"] = "job"
    job: Job


class WsAsset(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
        alias_generator=to_camel,
    )
    type: Literal["asset"] = "asset"
    asset: Asset


type WsEvent = WsHello | WsJob | WsAsset


class TimeRange(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
        alias_generator=to_camel,
    )
    start: float
    end: float


class MarkerFilter(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
        alias_generator=to_camel,
    )
    music_clip_id: str | None = Field(None, description="Чьи маркеры; по умолчанию — первый аудиоклип.")
    kinds: list[MarkerKind] | None = None
    min_strength: float | None = Field(None, ge=0.0, le=1.0)
    every: int | None = Field(None, ge=1)
    offset: int | None = Field(None, ge=0)
    section_labels: list[SectionLabel] | None = Field(
        None,
        description="Секции музыкального клипа (в timeline time) + project.sections.",
    )
    range: TimeRange | None = None


class ClipRef(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
        alias_generator=to_camel,
    )
    clip_id: str = Field(...)


class TrackRef(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
        alias_generator=to_camel,
    )
    track_id: str = Field(...)


class TrackInput(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
        alias_generator=to_camel,
    )
    id: str | None = None
    kind: TrackKind
    name: str
    muted: bool
    locked: bool
    hidden: bool
    volume: float | None = Field(None, ge=0.0, le=2.0)


class ClipInput(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
        alias_generator=to_camel,
    )
    id: str | None = None
    type: Literal["clip"] = "clip"
    asset_id: str = Field(...)
    start: float = Field(..., ge=0.0)
    duration: float = Field(..., gt=0.0)
    source_in: float = Field(..., ge=0.0)
    source_out: float = Field(..., gt=0.0)
    speed: float = Field(..., gt=0.0)
    reverse: bool
    time_remap: TimeRemap | None = Field(None)
    transform: Transform
    opacity: Animatable
    blend_mode: BlendMode = Field(...)
    volume: Animatable | None = None
    effects: list[EffectItem]
    markers: list[Marker]
    sections: list[Section] | None = None
    interpolated_asset_id: str | None = Field(None)
    label: str | None = None
    color: str | None = None


class ClipPatch(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
        alias_generator=to_camel,
    )
    asset_id: str | None = Field(None)
    start: float | None = Field(None, ge=0.0)
    duration: float | None = Field(None, gt=0.0)
    source_in: float | None = Field(None, ge=0.0)
    source_out: float | None = Field(None, gt=0.0)
    speed: float | None = Field(None, gt=0.0)
    reverse: bool | None = None
    transform: Transform | None = None
    opacity: Animatable | None = None
    blend_mode: BlendMode | None = Field(None)
    volume: Animatable | None = None
    interpolated_asset_id: str | None = Field(None)
    label: str | None = None
    color: str | None = None


class MarkerInput(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
        alias_generator=to_camel,
    )
    id: str | None = None
    t: float
    kind: MarkerKind
    strength: float = Field(..., ge=0.0, le=1.0)
    label: str | None = None
    color: str | None = None


class SectionInput(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
        alias_generator=to_camel,
    )
    id: str | None = None
    start: float
    end: float
    label: SectionLabel
    energy: float = Field(..., ge=0.0, le=1.0)
    description: str | None = None


class MarkerPatch(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
        alias_generator=to_camel,
    )
    t: float | None = None
    kind: MarkerKind | None = None
    strength: float | None = Field(None, ge=0.0, le=1.0)
    label: str | None = None
    color: str | None = None


class EffectInput(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
        alias_generator=to_camel,
    )
    id: str | None = None
    effect: str
    start: float
    duration: float = Field(..., gt=0.0)
    params: EffectParams
    envelope: Envelope
    anchor: EffectAnchor | None = None
    enabled: bool


class EffectPatch(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
        alias_generator=to_camel,
    )
    effect: str | None = None
    start: float | None = None
    duration: float | None = Field(None, gt=0.0)
    params: EffectParams | None = None
    envelope: Envelope | None = None
    anchor: EffectAnchor | None = None
    enabled: bool | None = None


class EnvelopePatch(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
        alias_generator=to_camel,
    )
    attack: float | None = Field(None, ge=0.0)
    hold: float | None = Field(None, ge=0.0)
    decay: float | None = Field(None, ge=0.0)
    curve: EnvelopeCurve | None = None


class OpAddTrack(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
        alias_generator=to_camel,
    )
    op: Literal["addTrack"] = "addTrack"
    track: TrackInput
    index: int | None = Field(None, ge=0)


class OpRemoveTrack(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
        alias_generator=to_camel,
    )
    op: Literal["removeTrack"] = "removeTrack"
    track_id: str = Field(...)


class Patch(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
        alias_generator=to_camel,
    )
    name: str | None = None
    muted: bool | None = None
    locked: bool | None = None
    hidden: bool | None = None
    volume: float | None = Field(None, ge=0.0, le=2.0)


class OpUpdateTrack(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
        alias_generator=to_camel,
    )
    op: Literal["updateTrack"] = "updateTrack"
    track_id: str = Field(...)
    patch: Patch


class OpMoveTrack(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
        alias_generator=to_camel,
    )
    op: Literal["moveTrack"] = "moveTrack"
    track_id: str = Field(...)
    index: int = Field(..., ge=0)


class OpAddClip(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
        alias_generator=to_camel,
    )
    op: Literal["addClip"] = "addClip"
    track_id: str = Field(...)
    clip: ClipInput


class OpUpdateClip(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
        alias_generator=to_camel,
    )
    op: Literal["updateClip"] = "updateClip"
    clip_id: str = Field(...)
    patch: ClipPatch


class OpMoveClip(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
        alias_generator=to_camel,
    )
    op: Literal["moveClip"] = "moveClip"
    clip_id: str = Field(...)
    start: float = Field(..., ge=0.0)
    track_id: str | None = Field(None)


class OpSplitClip(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
        alias_generator=to_camel,
    )
    op: Literal["splitClip"] = "splitClip"
    clip_id: str = Field(...)
    at: float = Field(..., description="Timeline time.")


class OpRemoveClip(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
        alias_generator=to_camel,
    )
    op: Literal["removeClip"] = "removeClip"
    clip_id: str = Field(...)
    ripple: bool | None = None


class OpSetTimeRemap(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
        alias_generator=to_camel,
    )
    op: Literal["setTimeRemap"] = "setTimeRemap"
    clip_id: str = Field(...)
    time_remap: TimeRemap | None = Field(...)


class OpAddMarkers(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
        alias_generator=to_camel,
    )
    op: Literal["addMarkers"] = "addMarkers"
    target: ClipRef | Literal["project"]
    markers: list[MarkerInput] = Field(..., min_length=1)


class OpUpdateMarker(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
        alias_generator=to_camel,
    )
    op: Literal["updateMarker"] = "updateMarker"
    marker_id: str = Field(...)
    patch: MarkerPatch


class OpRemoveMarkers(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
        alias_generator=to_camel,
    )
    op: Literal["removeMarkers"] = "removeMarkers"
    marker_ids: list[str] = Field(..., min_length=1)


class OpSetSections(BaseModel):
    """
    Заменяет весь список секций цели: clip.sections (source time) или project.sections (timeline time).
    """

    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
        alias_generator=to_camel,
    )
    op: Literal["setSections"] = "setSections"
    target: ClipRef | Literal["project"]
    sections: list[SectionInput]


class OpAddEffect(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
        alias_generator=to_camel,
    )
    op: Literal["addEffect"] = "addEffect"
    target: TrackRef | ClipRef
    effect: EffectInput


class OpUpdateEffect(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
        alias_generator=to_camel,
    )
    op: Literal["updateEffect"] = "updateEffect"
    effect_id: str = Field(...)
    patch: EffectPatch


class OpRemoveEffect(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
        alias_generator=to_camel,
    )
    op: Literal["removeEffect"] = "removeEffect"
    effect_id: str = Field(...)


class OpApplyEffectToMarkers(BaseModel):
    """
    Макро: раскрывается фронтом детерминированно в addEffect.
    """

    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
        alias_generator=to_camel,
    )
    op: Literal["applyEffectToMarkers"] = "applyEffectToMarkers"
    effect: str
    params: EffectParams | None = None
    envelope: EnvelopePatch | None = None
    duration: float | None = Field(None, gt=0.0)
    scale_by_strength: bool | None = Field(None, description="Сильнее на сильных маркерах.")
    filter: MarkerFilter
    target: TrackRef | Literal["newFxTrack", "clipsUnderMarker"]


type CutOrder = Literal["sequential", "random", "bestMoments"]


class OpCutToMarkers(BaseModel):
    """
    Макро: раскладывает клипы по слотам между маркерами.
    """

    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
        alias_generator=to_camel,
    )
    op: Literal["cutToMarkers"] = "cutToMarkers"
    clip_ids: list[str] = Field(..., min_length=1)
    filter: MarkerFilter
    track_id: str | None = Field(None)
    order: CutOrder
    seed: int | None = Field(None, description="Для order=random — детерминированность.")


class OpSnapClipEdgesToMarkers(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
        alias_generator=to_camel,
    )
    op: Literal["snapClipEdgesToMarkers"] = "snapClipEdgesToMarkers"
    clip_ids: list[str] = Field(..., min_length=1)
    filter: MarkerFilter
    max_shift: float = Field(..., gt=0.0)


type EditOp = (
    OpAddTrack
    | OpRemoveTrack
    | OpUpdateTrack
    | OpMoveTrack
    | OpAddClip
    | OpUpdateClip
    | OpMoveClip
    | OpSplitClip
    | OpRemoveClip
    | OpSetTimeRemap
    | OpAddMarkers
    | OpUpdateMarker
    | OpRemoveMarkers
    | OpSetSections
    | OpAddEffect
    | OpUpdateEffect
    | OpRemoveEffect
    | OpApplyEffectToMarkers
    | OpCutToMarkers
    | OpSnapClipEdgesToMarkers
)


class OpsResult(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
        alias_generator=to_camel,
    )
    ops: list[EditOp]
    explanation: str
    warnings: list[str] | None = None


class Selection(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
        alias_generator=to_camel,
    )
    clip_ids: list[str] = Field(...)
    marker_ids: list[str] = Field(...)
    effect_ids: list[str] = Field(...)


class ChatTurn(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
        alias_generator=to_camel,
    )
    role: Literal["user", "assistant"]
    text: str


class AICommandRequest(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
        alias_generator=to_camel,
    )
    project: Project
    selection: Selection
    playhead: float = Field(..., ge=0.0)
    message: str = Field(..., min_length=1)
    history: list[ChatTurn] | None = Field(None, max_length=10)


class CutDensity(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
        alias_generator=to_camel,
    )
    kinds: list[MarkerKind] = Field(..., min_length=1)
    every: int = Field(..., ge=1)
    min_strength: float = Field(..., ge=0.0, le=1.0)


class CutDensityMap(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
        alias_generator=to_camel,
    )
    intro: CutDensity
    verse: CutDensity
    build: CutDensity
    drop: CutDensity
    break_: CutDensity = Field(..., alias="break")
    outro: CutDensity
    other: CutDensity


class StyleEffectRule(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
        alias_generator=to_camel,
    )
    effect: str
    params: EffectParams
    filter: MarkerFilter
    probability: float = Field(..., ge=0.0, le=1.0)


class StyleGlobalEffect(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
        alias_generator=to_camel,
    )
    effect: str
    params: EffectParams


class StyleRampRule(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
        alias_generator=to_camel,
    )
    preset: str = Field(..., description="id из shared/fixtures/ramp_presets.json")
    where: Literal["drop-entry", "section-end", "random"]
    probability: float = Field(..., ge=0.0, le=1.0)


class StyleTransitionRule(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
        alias_generator=to_camel,
    )
    effect: str
    at: Literal["section-boundary", "downbeat"]
    probability: float = Field(..., ge=0.0, le=1.0)


class StylePreset(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
        alias_generator=to_camel,
    )
    id: str
    name: str
    description: str | None = None
    cut_density: CutDensityMap = Field(...)
    effects: list[StyleEffectRule]
    global_effects: list[StyleGlobalEffect] | None = Field(
        None,
        description="Эффекты на весь диапазон эдита (зерно, леттербокс, виньетка) — кладутся на fx-дорожку одним элементом.",
    )
    ramps: list[StyleRampRule]
    transitions: list[StyleTransitionRule]
    notes: str | None = None


class StylesFile(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
        alias_generator=to_camel,
    )
    version: int
    styles: list[StylePreset]


class RampPreset(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
        alias_generator=to_camel,
    )
    id: str
    name: str
    description: str
    time_remap: TimeRemap = Field(...)


class RampPresetsFile(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
        alias_generator=to_camel,
    )
    version: int
    presets: list[RampPreset]


type EffectCategory = Literal["camera", "light", "color", "distort", "stylize", "transition"]


type EffectParamType = Literal["number", "boolean", "color", "enum"]


class EffectParamDef(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
        alias_generator=to_camel,
    )
    key: str
    label: str
    type: EffectParamType
    default: float | str | bool
    min: float | None = None
    max: float | None = None
    step: float | None = None
    unit: Literal["px", "deg", "x", "Hz", "s", "%"] | None = None
    options: list[str] | None = None


class EffectDef(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
        alias_generator=to_camel,
    )
    id: str = Field(..., pattern="^[a-z][a-zA-Z0-9]*$")
    name: str
    category: EffectCategory
    default_duration: float = Field(..., gt=0.0)
    default_envelope: Envelope = Field(...)
    params: list[EffectParamDef]
    ai_hint: str = Field(...)


class EffectsRegistry(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
        alias_generator=to_camel,
    )
    version: int
    effects: list[EffectDef]


class AiCommandFixture(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
        alias_generator=to_camel,
    )
    id: str
    message: str
    selection: Selection | None = None
    playhead: float | None = None
    expected_ops: list[str] = Field(
        ...,
        description="Типы ops, которые должны присутствовать в ответе (порядок не важен).",
    )
    notes: str | None = None


class AiCommandsFile(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
        alias_generator=to_camel,
    )
    version: int
    project_fixture: str = Field(...)
    commands: list[AiCommandFixture]


class TimeRemapVectorSample(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
        alias_generator=to_camel,
    )
    tau: float
    src: float


class TimeRemapVector(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
        alias_generator=to_camel,
    )
    name: str
    remap: TimeRemap
    d: float = Field(..., alias="D")
    source_in: float = Field(...)
    source_out: float = Field(..., description="Для fit=free — ожидаемое вычисленное значение.")
    reverse: bool
    samples: list[TimeRemapVectorSample]


class TimeRemapVectorsFile(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
        alias_generator=to_camel,
    )
    version: int
    tolerance: float
    vectors: list[TimeRemapVector]


class Health(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
        alias_generator=to_camel,
    )
    status: Literal["ok"] = "ok"
    version: str
    schema_version: int = Field(...)
    ffmpeg: bool
    rife: bool
    demucs: bool
    gemini: bool
    gpus: list[str] | None = Field(
        None,
        description="Vulkan-устройства, которые видит rife-ncnn-vulkan; пустой список — RIFE не нашёл GPU (интерполяция через minterpolate); поля нет — RIFE нет или проверка ещё идёт.",
    )
    disk: DiskInfo
    registry_errors: list[str] | None = Field(
        None,
        description="Ошибки проверки shared/effects.json и shared/styles.json при старте бэка; поля нет — реестры в порядке.",
    )


class ImportResponse(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
        alias_generator=to_camel,
    )
    assets: list[Asset]
    jobs: list[JobRef]


class AutoEditRequest(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
        alias_generator=to_camel,
    )
    project: Project
    music_clip_id: str = Field(...)
    asset_ids: list[str] = Field(..., min_length=1)
    style: str = Field(..., description='id из shared/styles.json или "custom".')
    custom_style: StylePreset | None = Field(None)
    range: TimeRange | None = None
    intensity: float = Field(..., ge=0.0, le=1.0)
