# Контракт Frontend ↔ Backend

`schemaVersion: 1`. Этот документ описывает смысл; машиночитаемые версии — `shared/schema/project.schema.json` и `shared/schema/api.schema.json` (JSON Schema draft-07). Из них генерируются TS-типы (`npm run gen:types`) и Pydantic-модели (`uv run gen-models`). Фикстуры — `shared/fixtures/`, реестры — `shared/effects.json`, `shared/styles.json`. При расхождении прав `shared/schema`, документ исправляется следом.

Изменения — только через `docs/CONTRACT_CHANGES.md` (см. `PLAN.md` §6).

---

## 1. Соглашения

- **Время** — секунды, `number` (float64). Два вида:
  - *timeline time* — позиция на таймлайне проекта;
  - *source time* — позиция внутри исходного медиафайла.
  Поля называются явно: `start` (timeline), `sourceIn`/`sourceOut` (source), `t` у маркеров клипа — source time.
- **Кадры:** UI квантует время к сетке `1 / project.fps` при привязке и экспорте. В JSON хранится уже квантованное значение.
- **ID:** строки с префиксом + nanoid(10): `ast_…` ассет, `trk_…` дорожка, `clp_…` клип, `mrk_…` маркер, `fx_…` эффект, `sec_…` секция, `job_…` задача, `prj_…` проект, `pst_…` пресет эффектов. ID ассета детерминирован: `ast_` + первые 16 hex sha1(`абсолютный путь|размер|mtime`).
- **Координаты кадра** нормализованы: `x, y` ∈ [-1, 1] от центра кадра (0,0 — центр; `x = 1` — правый край, `y = 1` — **нижний**, ось y вниз, как в AE), `scale` 1 = cover (кадр заполняет выход без полей), `rotation` в градусах по часовой стрелке. `anchorX/anchorY` — точка поворота и масштаба в координатах слоя (−1..1 от его центра); смещение якоря само по себе слой не двигает: точка слоя `q` попадает в `центр + (x, y) + A + R·scale·(q − A)`. Те же правила для `centerX/centerY` эффектов.
- **Цвета** — `"#rrggbb"` или `"#rrggbbaa"`.
- **Ошибки API:** HTTP 4xx/5xx с телом `{ "error": { "code": "snake_case", "message": "…", "details": {} } }`.
- Все поля camelCase в JSON (на бэке Pydantic `alias_generator=to_camel`, `populate_by_name=True`).

## 2. Модель проекта

Нотация TypeScript-подобная; `?` — необязательное поле.

```ts
interface Project {
  schemaVersion: 1;
  id: string;                 // prj_
  name: string;
  fps: number;                // 24 | 25 | 30 | 50 | 60
  width: number;              // 1920
  height: number;             // 1080
  duration: number;           // длина композиции, сек
  background: string;         // цвет
  assets: Asset[];            // копия метаданных используемых ассетов
  tracks: Track[];            // порядок = порядок отрисовки снизу вверх (tracks[0] — самый нижний)
  markers: Marker[];          // маркеры композиции (timeline time)
  sections: Section[];        // секции композиции (timeline time): ручные / от ИИ. Секции из анализа музыки — в clip.sections
  createdAt: string;          // ISO 8601
  updatedAt: string;
  revision: number;           // +1 при каждом сохранении, для оптимистичной блокировки
}

type TrackKind = "video" | "audio" | "fx";

interface Track {
  id: string;                 // trk_
  kind: TrackKind;
  name: string;
  muted: boolean;
  locked: boolean;
  hidden: boolean;            // только video/fx
  volume?: number;            // audio, 0..2, по умолчанию 1
  items: (Clip | EffectItem)[]; // video/audio → Clip; fx → EffectItem; отсортированы по start, не перекрываются
}

interface Clip {
  id: string;                 // clp_
  type: "clip";
  assetId: string;
  start: number;              // timeline time начала
  duration: number;           // длительность на таймлайне
  sourceIn: number;           // source time первого кадра
  sourceOut: number;          // source time конца (для timeRemap.fit="stretch" задаёт потребляемый диапазон)
  speed: number;              // постоянная скорость, если timeRemap отсутствует; 1 по умолчанию; < 0 запрещено
  reverse: boolean;
  timeRemap?: TimeRemap;      // §5
  transform: Transform;       // только video
  opacity: Animatable;        // 0..1
  blendMode: "normal" | "add" | "screen" | "multiply" | "overlay";
  volume?: Animatable;        // audio-часть клипа (и у видео, если есть звук), 0..2
  effects: EffectItem[];      // эффекты, применённые к клипу; start — относительно начала клипа
  markers: Marker[];          // маркеры слоя в SOURCE time (двигаются вместе с клипом, как layer markers в AE)
  sections?: Section[];       // секции музыки из анализа, SOURCE time (двигаются вместе с клипом); только audio / видео со звуком
  interpolatedAssetId?: string; // производный ассет RIFE, см. §5.3
  label?: string;
  color?: string;
}

interface Transform {
  x: Animatable; y: Animatable;
  scale: Animatable; rotation: Animatable;
  anchorX: number; anchorY: number;   // нормализованные, 0 = центр
}

type Animatable = number | Keyframe[];  // число — константа; массив — ключи (t — время ОТ НАЧАЛА КЛИПА на таймлайне)

interface Keyframe {
  t: number;
  v: number;
  ease: Ease;                 // интерполяция от этого ключа к следующему
}

type Ease =
  | "linear" | "hold" | "easeIn" | "easeOut" | "easeInOut"
  | { bezier: [number, number, number, number] };  // как CSS cubic-bezier
// easeIn = [0.42,0,1,1], easeOut = [0,0,0.58,1], easeInOut = [0.42,0,0.58,1]

type MarkerKind = "bass" | "beat" | "downbeat" | "onset" | "manual" | "ai";

interface Marker {
  id: string;                 // mrk_
  t: number;                  // source time (маркер клипа) или timeline time (маркер проекта)
  kind: MarkerKind;
  strength: number;           // 0..1, у manual = 1
  label?: string;
  color?: string;
}

interface Section {
  id: string;                 // sec_
  start: number; end: number;
  label: "intro" | "verse" | "build" | "drop" | "break" | "outro" | "other";
  energy: number;             // 0..1
  description?: string;       // от Gemini
}

interface EffectItem {
  id: string;                 // fx_
  type: "effect";
  effect: string;             // id из shared/effects.json, напр. "shake"
  start: number;              // timeline time (на fx-дорожке) или время от начала клипа (в clip.effects)
  duration: number;
  params: Record<string, number | string | boolean>;  // ключи и диапазоны — из реестра
  envelope: Envelope;
  anchor?: { markerId: string; clipId?: string; offset: number }; // привязка к маркеру: start = время маркера + offset; при перемещении маркера эффект едет следом
  enabled: boolean;
}

interface Envelope {          // огибающая интенсивности 0..1 внутри [start, start+duration]
  attack: number;             // сек нарастания
  hold: number;               // сек на максимуме
  decay: number;              // сек затухания (остаток длительности, если не влезает)
  curve: "linear" | "exp" | "easeOut";
}
```

### Инварианты (проверяют обе стороны)

1. Элементы дорожки не перекрываются, отсортированы по `start`.
2. `video`/`audio` дорожки содержат только `Clip`, `fx` — только `EffectItem`.
3. `0 ≤ sourceIn < sourceOut ≤ asset.duration`.
4. Без `timeRemap`: `duration = (sourceOut − sourceIn) / speed`.
5. `assetId` ссылается на ассет из `project.assets`.
6. `anchor.markerId` ссылается на существующий маркер; если маркер удалён — `anchor` снимается, эффект остаётся на месте.
7. Порядок рендера: дорожки снизу вверх; эффект fx-дорожки применяется к композиту всех дорожек **ниже** неё (как adjustment layer).
8. Секции одного списка (`project.sections` или `clip.sections`) отсортированы по `start`, не перекрываются, `start < end`; ID секций и маркеров уникальны во всём проекте. Секции клипа могут выходить за `[sourceIn, sourceOut]` — UI и макро-ops обрезают их по видимому диапазону.

### 2.1 Интенсивность эффекта (огибающая)

Одна формула для превью, экспорта и экспорта в AE. `D = effect.duration`, `τ` — время от начала эффекта; вне `[0, D)` интенсивность 0, выключенный эффект (`enabled: false`) не рендерится.

- `A = min(attack, D)`, `H = min(hold, D − A)`, `R = min(decay, D − A − H)`; после `A + H + R` интенсивность 0 (если сумма меньше `D`).
- атака `τ < A`: `p = τ / A`, `env = up(p)`; удержание: `env = 1`; затухание: `q = (τ − A − H) / R`, `env = down(q)`; нулевая фаза пропускается.
- `curve`: `linear` — `up = p`, `down = 1 − q`; `easeOut` — `up = 1 − (1 − p)²`, `down = (1 − q)²`; `exp` (k = 5) — `up = (1 − e^(−k·p)) / (1 − e^(−k))`, `down = (e^(−k·q) − e^(−k)) / (1 − e^(−k))`.
- `intensity = env × strength`, где `strength` — параметр эффекта (нет ключа в `params` — дефолт реестра; у переходов параметра нет — 1). Шейдер эффекта получает `intensity` (0..2) и масштабирует им своё действие (смесь с исходным кадром / амплитуду).
- Отсутствующие в `params` ключи берутся из дефолтов реестра (§7); хранить все параметры необязательно.
- Привязка `anchor` (обе стороны, после каждой транзакции): эффект, который в транзакции создан или изменён напрямую (`start`/`anchor`), остаётся на месте — пересчитывается `anchor.offset`; остальные привязанные эффекты ставятся в «время маркера на таймлайне + offset» (у эффекта клипа — минус `clip.start`). Маркер вне видимого диапазона клипа — эффект не двигается. Сдвинутый так эффект fx-дорожки, наехавший на следующий элемент, укорачивается до него.

## 3. Ассеты

```ts
type AssetKind = "video" | "audio" | "image";

interface Asset {
  id: string;                 // ast_
  kind: AssetKind;
  name: string;               // имя файла
  path: string;               // абсолютный путь к оригиналу
  duration: number;           // 0 для image
  width?: number; height?: number;
  fps?: number;               // реальный (r_frame_rate)
  hasAudio: boolean;
  codec: string;              // "h264" | "hevc" | "prores" | "aac" | "mp3" …
  browserDecodable: boolean;  // false → используется mezzanine для экспорта
  status: "importing" | "ready" | "failed";
  derived: {                  // URL относительно бэка; поле появляется, когда файл готов
    proxy?: string;           // /api/assets/{id}/proxy.mp4 — 720p H.264, GOP 10, AAC
    mezzanine?: string;       // /api/assets/{id}/mezzanine.mp4 — полное разрешение H.264 CRF 16 (только если !browserDecodable)
    audio?: string;           // /api/assets/{id}/audio.m4a
    thumbs?: string;          // /api/assets/{id}/thumbs.json — см. ниже
    waveform?: string;        // /api/assets/{id}/waveform.json
  };
  parent?: { assetId: string; kind: "interpolated"; factor: number; sourceIn: number; sourceOut: number }; // для производных
}

// thumbs.json
interface Thumbs { interval: number; tileWidth: number; tileHeight: number; columns: number; rows?: number; count: number; sprites: string[] } // sprites — URL JPG-атласов; rows по умолчанию = columns; атлас кадра i = floor(i / (columns·rows))

// waveform.json — пики для отрисовки
interface Waveform { sampleRate: number; samplesPerPeak: number; channels: 1; peaks: number[] } // пары [min,max,min,max,…], int8 -128..127
```

## 4. Анализ

```ts
interface MusicAnalysis {
  assetId: string;
  params: MusicAnalysisParams;
  bpm: number;
  beats: number[];            // source time
  downbeats: number[];
  bass: { t: number; strength: number }[];   // strength нормализован 0..1 по треку
  onsets: { t: number; strength: number }[]; // широкополосные, для мелких акцентов
  sections: Omit<Section, "id">[];            // source time
  energy: { interval: number; values: number[] }; // RMS-кривая 0..1, для подсветки
  stems?: { drums?: string; bass?: string };      // URL, если запускался Demucs
}

interface MusicAnalysisParams {
  bassCutoffHz: number;       // 150
  sensitivity: number;        // 0..1, 0.5
  minGapSec: number;          // 0.12
  useStems: boolean;          // false — Demucs
}

interface ClipAnalysis {
  assetId: string;
  model: string;              // какая модель Gemini
  summary: string;
  moments: { start: number; end: number; score: number; tags: string[]; description: string }[]; // source time, score 0..1
  shots: { start: number; end: number; type: "closeup" | "medium" | "wide" | "other" }[];
  motion: { interval: number; values: number[] };   // локально посчитанная энергия движения 0..1 (не Gemini)
}
```

Перенос анализа в проект (одной транзакцией ops: `removeMarkers` старых автоматических + `addMarkers` + `setSections`):

- маркеры → `clip.markers` в source time (без пересчёта): `bass` → kind `bass` (strength из анализа); `downbeats` → `downbeat` (strength 1); `beats`, не совпадающие с даунбитом (±1 мс), → `beat` (strength 1); `onsets` → `onset` (strength из анализа);
- маркеры `onset` по умолчанию скрыты фильтром видимости UI (чекбокс вида выключен); `MarkerFilter.kinds` по умолчанию `["bass"]`, так что в макро-ops они не попадают, пока их не запросят явно;
- секции → `clip.sections` в source time (`setSections` с `target: {clipId}`), а не в `project.sections`: так они едут вместе с клипом при `moveClip`/триме, как маркеры (DECISIONS #8);
- «Переанализировать» заменяет маркеры видов `bass`/`beat`/`downbeat`/`onset` и `clip.sections`; маркеры `manual` и `ai` сохраняются;
- для видеоклипа со звуком — то же самое, анализ берётся по его ассету.

## 5. Speed ramp (TimeRemap)

```ts
interface TimeRemap {
  keyframes: { u: number; speed: number; ease: Ease }[]; // u ∈ [0,1] — доля длительности клипа; первый u=0, последний u=1; speed > 0
  fit: "stretch" | "free";
  frameBlend: boolean;        // смешивать соседние кадры, если нет интерполированного ассета
}
```

### 5.1 Математика (обязательна для обеих сторон, одинаковая)

Пусть `D = clip.duration`, `s(u)` — профиль скорости, интерполированный между ключами по `ease` (ease применяется к параметру между соседними `u`, значение — линейная смесь `speed`).

- Между ключами `a` и `b`: `p = (u − a.u) / (b.u − a.u)`, `s(u) = a.speed + (b.speed − a.speed) · E(a.ease, p)`.
- `E`: `linear` → `p`; `hold` → `0` при `p < 1` (скорость `a.speed` до следующего ключа); именованные и `{bezier}` → CSS cubic-bezier (x→y: 8 итераций Ньютона, затем бисекция до 1e-7).
- До первого ключа / после последнего — скорость крайнего ключа.
- Эталонная реализация: `backend/app/timeremap.py`.

- `S(u) = ∫₀ᵘ s(x) dx` — численно, Симпсон, 256 отрезков на каждый интервал между ключами.
- **fit = "stretch"**: коэффициент `k = (sourceOut − sourceIn) / (D · S(1))`. Эффективная скорость `k·s(u)`. Source time в момент `τ ∈ [0, D]` от начала клипа: `src(τ) = sourceIn + D · k · S(τ / D)`. Клип ровно укладывает выбранный диапазон исходника в слот на таймлайне.
- **fit = "free"**: `k = 1`; `sourceOut` вычисляется: `sourceOut = sourceIn + D · S(1)`, валидируется ≤ `asset.duration`.
- `reverse`: `src'(τ) = sourceOut − (src(τ) − sourceIn)`.

Эталонные векторы: `shared/fixtures/time_remap_vectors.json` — `{remap, D, sourceIn, sourceOut, samples: [{tau, src}]}`; допуск 1e-4 с. Обе стороны гоняют их в тестах.

### 5.2 Пресеты (`shared/fixtures/ramp_presets.json`)

| id | Ключи (u: speed) | Смысл |
|---|---|---|
| `fast-slow-fast` | 0:3 easeInOut → 0.35:0.25 hold → 0.65:0.25 easeInOut → 1:3 | velocity-классика |
| `slow-end` | 0:1 easeIn → 0.6:1 → 1:0.2 | замедление к концу |
| `ramp-to-drop` | 0:0.3 easeIn → 1:4 | разгон к дропу |
| `slow-start` | 0:0.2 easeOut → 0.4:1 → 1:1 | выход из замедления |
| `pulse` | 0:2 → 0.5:0.4 → 1:2 | качели на один бит |

### 5.3 Интерполяция кадров

Если минимальная эффективная скорость клипа `< 0.8` и у исходника `fps · minSpeed < project.fps`, фронт запрашивает `POST /api/assets/{id}/interpolate` с `factor = min(16, nextPow2(ceil(project.fps / (asset.fps · minSpeed))))` и диапазоном `[sourceIn − 0.1, sourceOut + 0.1]`. Бэк возвращает производный ассет с `fps = asset.fps · factor`, **покрывающий тот же source time** (временные метки не сдвигаются — `src(τ)` используется как есть, пересчёт не нужен). ID пишется в `clip.interpolatedAssetId`. Пока задача не готова — `frameBlend`.

## 6. Edit-ops

Единый формат изменений проекта: используется ИИ (копилот, автоэдит) и может использоваться для макро-действий UI. Фронт применяет список ops одной транзакцией (одна запись undo). Неизвестный `op` или битая ссылка → вся транзакция отклоняется с ошибкой.

```ts
type EditOp =
  | { op: "addTrack"; track: Omit<Track, "items"> & { items?: [] }; index?: number }
  | { op: "removeTrack"; trackId: string }
  | { op: "updateTrack"; trackId: string; patch: Partial<Pick<Track, "name" | "muted" | "locked" | "hidden" | "volume">> }
  | { op: "moveTrack"; trackId: string; index: number }  // индекс в project.tracks (порядок отрисовки снизу вверх)
  | { op: "addClip"; trackId: string; clip: Omit<Clip, "id"> & { id?: string } }
  | { op: "updateClip"; clipId: string; patch: Partial<Omit<Clip, "id" | "type">> }
  | { op: "moveClip"; clipId: string; start: number; trackId?: string }
  | { op: "splitClip"; clipId: string; at: number }          // timeline time
  | { op: "removeClip"; clipId: string; ripple?: boolean }
  | { op: "setTimeRemap"; clipId: string; timeRemap: TimeRemap | null }
  | { op: "addMarkers"; target: { clipId: string } | "project"; markers: (Omit<Marker, "id"> & { id?: string })[] }
  | { op: "updateMarker"; markerId: string; patch: Partial<Omit<Marker, "id">> }
  | { op: "removeMarkers"; markerIds: string[] }
  | { op: "setSections"; target: { clipId: string } | "project"; sections: (Omit<Section, "id"> & { id?: string })[] }
  | { op: "addEffect"; target: { trackId: string } | { clipId: string }; effect: Omit<EffectItem, "id" | "type"> & { id?: string } }
  | { op: "updateEffect"; effectId: string; patch: Partial<Omit<EffectItem, "id" | "type">> }
  | { op: "removeEffect"; effectId: string }
  // макро-ops (раскрываются фронтом детерминированно в примитивные)
  | { op: "applyEffectToMarkers"; effect: string; params?: Record<string, unknown>; envelope?: Partial<Envelope>; duration?: number;
      scaleByStrength?: boolean;   // сила эффекта × strength маркера
      filter: MarkerFilter; target: { trackId: string } | "newFxTrack" | "clipsUnderMarker" }
  | { op: "cutToMarkers"; clipIds: string[]; filter: MarkerFilter; trackId?: string; order: "sequential" | "random" | "bestMoments"; seed?: number }
  | { op: "snapClipEdgesToMarkers"; clipIds: string[]; filter: MarkerFilter; maxShift: number };

interface MarkerFilter {
  musicClipId?: string;       // чьи маркеры; по умолчанию — первый аудиоклип
  kinds?: MarkerKind[];       // по умолчанию ["bass"]
  minStrength?: number;       // 0..1
  every?: number;             // каждый N-й (1 = все)
  offset?: number;            // сдвиг для every (0 = начиная с первого)
  sectionLabels?: Section["label"][]; // секции музыкального клипа (пересчитанные в timeline time) + project.sections
  range?: { start: number; end: number }; // timeline time
}

interface OpsResult { ops: EditOp[]; explanation: string; warnings?: string[] }
```

Временные ID в ops (`id`, начинающиеся с `tmp_`) допустимы: на них можно ссылаться в последующих ops того же списка; фронт заменяет их на настоящие.

### 6.1 Семантика примитивных ops

Обе стороны (фронт — `applyOps`, бэк — сухой прогон в `validate_ops`) обязаны давать одинаковый результат:

1. `splitClip` у клипа с `timeRemap`: обе половины получают ключи, обрезанные по `u` и перенормированные в [0,1], и `fit: "stretch"` с точными диапазонами `[sourceIn, src(τ)]` / `[src(τ), sourceOut]` (стык непрерывен). Для `reverse` левая половина берёт конец диапазона исходника. Маркеры клипа уходят в половину, чей source-диапазон их содержит (ID сохраняются, `anchor.clipId` переадресуется); эффекты клипа — по своему `start`; ключи `transform/opacity/volume` делятся с граничным ключом.
2. `setTimeRemap(null)` сохраняет слот и потреблённый диапазон: `sourceOut` = фактический, `speed = (sourceOut − sourceIn) / duration`.
3. `removeClip(ripple)` сдвигает влево на `duration` только элементы той же дорожки, начинающиеся не раньше конца удалённого.
4. `project.duration` пересчитывается после каждой транзакции как максимум `start + duration` по всем элементам дорожек.
5. `addClip` с `assetId`, которого нет в `project.assets`, копирует метаданные ассета из библиотеки (`GET /assets`), иначе ошибка `asset_not_found`.
6. Инвариант 3 для `image`: верхняя граница `asset.duration` (= 0) не проверяется; `sourceIn/sourceOut` — условные (`0 … duration·speed`).
7. `moveTrack.index` — итоговая позиция дорожки в `project.tracks` после переноса; индекс за концом → в конец (как `addTrack.index`); нецелый или < 0 → ошибка `bad_value`.
8. `updateTrack.patch.volume` допустим только у `audio`-дорожки, 0..2; пустое имя → `bad_value`.
9. `setSections` заменяет весь список секций цели (пустой массив — очистить). Время — source time для `{clipId}`, timeline time для `"project"`. Вход сортируется по `start`; перекрытие или `start ≥ end` → `bad_value`. Переданный `id` сохраняется (`tmp_` заменяется), без `id` — новый `sec_`. Цель `{clipId}` допустима только для клипа audio-дорожки или видеоклипа с `hasAudio`, иначе `bad_value`. `updateClip.patch` не содержит `markers`/`sections` — для них только marker-ops и `setSections`.
10. `splitClip` и `clip.sections`: каждая половина получает секции, пересекающиеся с её source-диапазоном, без обрезки границ; секция, попавшая в обе половины, остаётся с исходным ID в левой половине, в правой получает новый `sec_`. `moveClip` и трим секции клипа не меняют (они в source time).
11. Привязка (snapping) и `MarkerFilter.sectionLabels` используют и `project.sections`, и секции клипов (пересчитанные в timeline time через `start`, `sourceIn`, скорость/`timeRemap` клипа).

### 6.2 Семантика макро-ops (фронт раскрывает их в примитивные ops внутри той же транзакции)

Макро-op видит проект в состоянии после предыдущих ops списка. Любая ошибка отклоняет всю транзакцию. Бэк макро-ops не раскрывает (ИИ возвращает их как есть, фронт исполняет).

**Фильтр маркеров (`MarkerFilter`)** — общий для всех макро-ops:
- источник: маркеры музыкального клипа (`musicClipId`; по умолчанию первый клип аудиодорожки с маркерами, иначе первый клип аудиодорожки), пересчитанные в timeline time; маркеры вне видимого диапазона клипа отбрасываются. Нет музыкального клипа — маркеры проекта (`project.markers`);
- порядок применения: `kinds` (по умолчанию `["bass"]`) → `minStrength` → `sectionLabels` (секции этого клипа + `project.sections`; маркер попадает в секцию при `start ≤ t < end`) → `range` (включительно) → `every`/`offset` по оставшимся (индекс `i` проходит, если `i ≥ offset` и `(i − offset) % every = 0`);
- `every` — целое ≥ 1, `offset` — целое ≥ 0, `minStrength` ∈ [0,1], `range.start ≤ range.end`, иначе `bad_value`; неизвестный `musicClipId` — `clip_not_found`.

**`cutToMarkers`**:
1. Слоты — интервалы между соседними отфильтрованными маркерами (N маркеров → N−1 слотов). Маркер ближе одного кадра проекта к предыдущему оставленному отбрасывается. Стык слотов — ровно в маркере (без квантования к кадру), пробелов и перекрытий нет. Меньше двух маркеров → `no_slots`.
2. `clipIds` — исходные клипы (только видеодорожки, иначе `incompatible_track`; неизвестный — `clip_not_found`), упорядочиваются по `start`. Они **удаляются** (`removeClip` без ripple), на целевую дорожку (`trackId`, по умолчанию дорожка первого исходного клипа; только `video`) кладутся клипы слотов. Другие элементы целевой дорожки под слотами → `slots_overlap`.
3. Кусок исходника для слота длительностью `d` (диапазон исходного клипа — `[sourceIn, effectiveSourceOut]`):
   - `sequential` — следующий кусок `d` по порядку клипов (внутри клипа подряд, остаток короче `d` пропускается, после последнего — по кругу с первого);
   - `random` — клип пропорционально длине диапазона, смещение равномерно (квантуется к кадру проекта); ГПСЧ mulberry32 с `seed` (по умолчанию 1), результат детерминирован;
   - `bestMoments` — моменты `ClipAnalysis.moments` исходных клипов (обрезанные по диапазону клипа) по убыванию `score`; момент короче слота центрируется в окне, длиннее — берётся с начала; закончились моменты или анализа нет — как `sequential`.
   Если диапазона не хватает на `d`, кусок целиком растягивается замедлением (`speed < 1`); для картинок `sourceIn = 0`.
4. Новый клип: `speed` 1 (кроме замедления выше), `reverse: false`, без `timeRemap`, эффектов, маркеров и секций; `transform`/`opacity` по умолчанию; `blendMode` и `color` — с исходного клипа, `volume` — только если это константа. Инварианты 1–5 выполняются.

**`applyEffectToMarkers`**:
1. `effect` — id из реестра, иначе `unknown_effect`. `params` проверяются по реестру (неизвестный ключ, число вне `min..max`, значение не из `options`, не тот тип) → `bad_value`; в эффект пишутся только переданные `params`. `duration` > 0 (по умолчанию `defaultDuration` эффекта), `envelope` — `defaultEnvelope` эффекта, поверх — переданные поля.
2. Маркеры — по `MarkerFilter`; маркер ближе одного кадра проекта к предыдущему оставленному отбрасывается (как в `cutToMarkers`). Не осталось ни одного → `no_markers`.
3. Длительность эффекта на маркере `i`: `dᵢ = min(duration, tᵢ₊₁ − tᵢ)` (последний — `duration`), так эффекты одного вызова не перекрываются.
4. `scaleByStrength: true` — `params.strength = clamp(strength × marker.strength, min, max)`, где `strength` — переданный или дефолтный; у эффекта без параметра `strength` (переходы) флаг игнорируется.
5. Цель:
   - `{trackId}` — только `fx`-дорожка (`incompatible_track`; неизвестная — `track_not_found`); эффект `start = tᵢ`, `duration = dᵢ`. Любой существующий элемент дорожки, пересекающийся с `[tᵢ, tᵢ + dᵢ)`, → `slots_overlap`;
   - `"newFxTrack"` — новая `fx`-дорожка поверх всех (в конец `project.tracks`), имя `"FX: <name эффекта>"`, туда — как в `{trackId}`;
   - `"clipsUnderMarker"` — в `clip.effects` каждого клипа видеодорожек (включая скрытые), для которого `start ≤ tᵢ < start + duration`; `start = tᵢ − clip.start`, `duration = min(dᵢ, clip.start + clip.duration − tᵢ)`; эффект добавляется в конец `clip.effects`. Маркеры без клипа под собой пропускаются; ни одного эффекта → `no_markers`.
6. Каждый эффект: новый `fx_`, `enabled: true`, `anchor = {markerId, clipId?: id музыкального клипа (нет для маркеров проекта), offset: 0}`.

**`snapClipEdgesToMarkers`**: клипы обрабатываются слева направо; для начала, затем конца каждого клипа ищется ближайший отфильтрованный маркер на расстоянии ≤ `maxShift` (сек, ≥ 0); край сдвигается тримом (`updateClip`) в пределах соседей по дорожке, доступного исходника и минимума в 1 кадр (как ручной трим), поэтому цель может быть достигнута не полностью. Если конец одного выбранного клипа лежит впритык к началу следующего выбранного, стык сдвигается вместе (оба края к одному маркеру). Нет маркеров или сдвигать нечего — ops не создаются.

## 7. Реестр эффектов (`shared/effects.json`)

```ts
interface EffectDef {
  id: string;                 // "shake"
  name: string;               // "Шейк"
  category: "camera" | "light" | "color" | "distort" | "stylize" | "transition";
  defaultDuration: number;
  defaultEnvelope: Envelope;
  params: {
    key: string; label: string;
    type: "number" | "boolean" | "color" | "enum";
    default: number | boolean | string;
    min?: number; max?: number; step?: number; unit?: string; // unit: "px" | "deg" | "x" | "Hz" | "s" | "%"
    options?: string[];       // для enum
  }[];
  aiHint: string;             // короткое описание для промпта Gemini
}
```

Файл: `{ version: 1, effects: EffectDef[] }`. Параметр `strength` (0..2, по умолчанию 1) есть у всех эффектов, кроме переходов: общий множитель интенсивности (§2.1), на него действует `scaleByStrength`.

Стартовый набор (фаза 4): `shake`, `zoomPunch`, `panCrop`, `flicker`, `strobe`, `flash`, `rgbSplit`, `invert`, `zoomBlur`, `directionalBlur`, `glow`, `filmGrain`, `vignette`, `letterbox`, `contrastPunch`, `tilt3d`, `chromaWave`; переходы: `whipPan`, `zoomTransition`, `blurTransition`, `flashTransition`, `glitchTransition`. Параметры — в `shared/effects.json`.

## 8. HTTP API

База: `http://127.0.0.1:8765/api`. CORS разрешён только для `http://localhost:5173` и `tauri://localhost`.

| Метод | Путь | Тело / параметры | Ответ |
|---|---|---|---|
| GET | `/health` | — | `{status:"ok", version, schemaVersion, ffmpeg:bool, rife:bool, demucs:bool, gemini:bool, registryErrors?: string[]}` — `registryErrors` только если `shared/effects.json` / `styles.json` не прошли проверку при старте |
| POST | `/assets/import` | `{paths: string[]}` | `{assets: Asset[], jobs: JobRef[]}` |
| POST | `/assets/upload` | multipart `files[]` (для браузерного режима; файл копируется в `data/uploads`) | `{assets: Asset[], jobs: JobRef[]}` |
| GET | `/assets` | — | `Asset[]` |
| GET | `/assets/{id}` | — | `Asset` |
| GET | `/assets/{id}/proxy.mp4`, `/mezzanine.mp4`, `/original`, `/audio.m4a` | Range | поток (`206`) |
| GET | `/assets/{id}/thumbs.json`, `/thumbs/{n}.jpg`, `/waveform.json` | — | файл |
| POST | `/assets/{id}/interpolate` | `{sourceIn, sourceOut, factor}` | `JobRef` → результат `Asset` |
| POST | `/assets/{id}/stems` | — | `JobRef` → результат `{drums, bass, other, vocals}` URL |
| GET | `/assets/{id}/stems/{name}.wav` | — | WAV стема (`name`: drums, bass, other, vocals), Range |
| POST | `/analysis/music/{id}` | `MusicAnalysisParams` (частично) | `JobRef` → результат `MusicAnalysis` |
| GET | `/analysis/music/{id}` | — | `MusicAnalysis` или 404 |
| GET | `/analysis/clip/{id}` | — | `ClipAnalysis` или 404. Без Gemini: `model: ""`, `moments: []`, `shots` — склейки (`type: "other"`), `motion`; бэк считает после импорта видео (задача `clipAnalysis`) |
| GET | `/projects` | — | `{id,name,updatedAt}[]` |
| POST | `/projects` | `{name, fps, width, height}` | `Project` |
| GET | `/projects/{id}` | — | `Project` |
| PUT | `/projects/{id}` | `Project` (с текущим `revision`) | `Project` (revision+1) или 409 при конфликте |
| GET | `/presets` | — | `EffectPreset[]` (порядок создания) |
| POST | `/presets` | `CreateEffectPresetRequest` `{name, description?, effects}` | `EffectPreset` с новым `id` (`pst_`) |
| POST | `/ai/analyze-clip/{id}` | `{force?: bool}` | `JobRef` → `ClipAnalysis` |
| POST | `/ai/analyze-music/{id}` | — | `JobRef` → `MusicAnalysis` (секции обогащены) |
| POST | `/ai/command` | `AICommandRequest` | `OpsResult` |
| POST | `/ai/auto-edit` | `AutoEditRequest` | `JobRef` → `OpsResult` |
| POST | `/ai/style-from-reference/{id}` | — | `JobRef` → `StylePreset` |
| POST | `/export/ae-jsx` | `Project` | скрипт ExtendScript для After Effects: `text/javascript; charset=utf-8`, `Content-Disposition: attachment` (§8.3) |
| GET | `/jobs/{id}` | — | `Job` |
| DELETE | `/jobs/{id}` | — | `Job` (canceled) |
| WS | `/ws` | — | поток `WsEvent` |
| POST | `/debug/sleep-job` | `{seconds, steps}` | `JobRef` — тестовая задача; только при `AIEDITOR_DEBUG=1` |

```ts
interface JobRef { jobId: string }
interface Job {
  id: string; kind: "import" | "proxy" | "thumbs" | "waveform" | "mezzanine" | "audio" | "musicAnalysis" | "stems"
    | "interpolate" | "clipAnalysis" | "aiMusic" | "autoEdit" | "styleRef" | "debug";
  assetId?: string;
  status: "queued" | "running" | "done" | "failed" | "canceled";
  progress: number;           // 0..1
  message?: string;
  result?: unknown;           // тип зависит от kind (см. таблицу)
  error?: { code: string; message: string };
  createdAt: string; updatedAt: string;
}

type WsEvent =
  | { type: "hello"; version: string; schemaVersion: number }
  | { type: "job"; job: Job }                   // при каждом изменении статуса/прогресса (прогресс не чаще 4 раз/с)
  | { type: "asset"; asset: Asset };            // при появлении производных файлов

interface AICommandRequest {
  project: Project;
  selection: { clipIds: string[]; markerIds: string[]; effectIds: string[] };
  playhead: number;
  message: string;
  history?: { role: "user" | "assistant"; text: string }[]; // последние 10 реплик
}

interface AutoEditRequest {
  project: Project;
  musicClipId: string;
  assetIds: string[];         // видео для нарезки
  style: string;              // id из shared/styles.json или "custom"
  customStyle?: StylePreset;
  range?: { start: number; end: number };  // какой участок трека монтировать, по умолчанию весь клип
  intensity: number;          // 0..1 — насколько агрессивны эффекты
}

interface StylePreset {
  id: string; name: string; description?: string;
  cutDensity: Record<Section["label"], { kinds: MarkerKind[]; every: number; minStrength: number }>;
  effects: { effect: string; params: Record<string, unknown>; filter: MarkerFilter; probability: number }[];
  globalEffects?: { effect: string; params: Record<string, unknown> }[]; // на весь диапазон эдита (зерно, леттербокс)
  ramps: { preset: string; where: "drop-entry" | "section-end" | "random"; probability: number }[];
  transitions: { effect: string; at: "section-boundary" | "downbeat"; probability: number }[];
  notes?: string;
}

// shared/styles.json = { version: 1, styles: StylePreset[] }

interface EffectPreset {      // пользовательский пресет-комбо (/presets)
  id: string; name: string; description?: string;
  effects: { effect: string; start: number; duration: number; params: Record<string, unknown>; envelope: Envelope }[]; // start — от точки применения
}

interface CreateEffectPresetRequest { name: string; description?: string; effects: EffectPreset["effects"] } // POST /presets
```

### 8.1 Импорт и готовность ассета

- `POST /assets/import|upload` возвращает ассеты со `status: "importing"` и `jobs` — шаги цепочки (`proxy`, `thumbs`, `waveform`, `mezzanine`, `audio`). Отдельной задачи kind `import` нет (значение зарезервировано).
- Конец импорта — WS-событие `asset` со `status: "ready"` (или `"failed"`, если у видео не создан proxy / у аудио — audio.m4a). Промежуточные события `asset` приходят при каждом новом производном файле.
- Повторный импорт готового ассета → тот же ассет и `jobs: []`; идущего — его текущие задачи. Изображения сразу `ready`, без задач.

### 8.2 Коды ошибок

| Эндпоинт | HTTP | `code` | `details` |
|---|---|---|---|
| `POST /assets/import`, `/assets/upload` | 400 | `file_not_found` | `paths` |
| | 400 | `no_files` | — |
| | 422 | `unsupported_media` | `files: {путь: причина}` |
| | 503 | `ffmpeg_missing` | — |
| `GET /assets/{id}…` | 404 | `asset_not_found` | — |
| | 404 | `file_not_found` | производный файл ещё не готов |
| `/projects/{id}` | 404 | `project_not_found` | — |
| `PUT /projects/{id}` | 400 | `project_id_mismatch` | id в теле ≠ id в пути |
| | 409 | `revision_conflict` | `revision` — текущая ревизия |
| `/jobs/{id}` | 404 | `job_not_found` | — |
| `GET /analysis/music/{id}`, `GET /analysis/clip/{id}` | 404 | `analysis_not_found` | анализ ещё не выполнен |
| `POST /analysis/…/{id}`, `/assets/{id}/stems` | 404 | `asset_not_found` | — |
| | 422 | `no_audio` | у ассета нет звука (изображение, видео без аудио) |
| `POST /assets/{id}/stems`, `POST /analysis/music/{id}` с `useStems: true` | 501 | `demucs_not_installed` | — |
| `POST /presets` | 422 | `invalid_preset` | `errors: string[]` — неизвестный эффект или параметр, значение вне диапазона / не из `options` / не того типа |
| любой | 422 | `validation_error` | ошибки валидации |

Ошибка задачи ffmpeg: `job.error.code = "ffmpeg_failed"`.

### 8.3 Экспорт

**MP4 (в браузере, без бэка).** Кадр `i` выхода — timeline time `T = start + i / fps` (`start` — начало диапазона: 0 или in-точка); план и шейдеры — те же, что в превью (§2.1, порядок рендера — инвариант 7). Источник кадра клипа — первый декодируемый из: оригинал интерполированного ассета (`clip.interpolatedAssetId`, §5.3), `/original` (если `browserDecodable`), `/mezzanine.mp4`, `/original`, `/proxy.mp4`; берётся последний кадр с PTS ≤ `src(τ)`. Звук — сведение всех не muted дорожек (solo — состояние сессии, в экспорт не попадает) с громкостями дорожек и клипов, скоростью/`reverse`/`timeRemap` как при воспроизведении; 48 кГц стерео, AAC 320 кбит/с (если браузер не кодирует AAC — Opus). Контейнер MP4.

**After Effects (`POST /export/ae-jsx`).** Тело — `Project`; ответ — самодостаточный ASCII-скрипт (`var DATA = {…};` + интерпретатор), запуск: File → Scripts → Run Script File. Создаётся композиция (`fps`, размер, длительность, фон) и папка с импортированными оригиналами (`asset.path`; нет файла — серый solid «НЕТ ФАЙЛА» и предупреждение в конце). Слои добавляются в порядке `project.tracks` снизу вверх, внутри дорожки — по `start`:
- клип: `inPoint = start`, `outPoint = start + duration`; при `speed = 1` без `reverse`/`timeRemap` — `startTime = start − sourceIn`, иначе time remap: при постоянной скорости — два ключа, с `timeRemap` — ключ на каждый кадр проекта, значение `src(τ)` по §5.1;
- transform: якорь — `anchorX/anchorY`, позиция (разделённые X/Y) и масштаб пересчитываются из нормализованных координат и cover-масштаба (§1), поворот — градусы, непрозрачность — %; ключи `Animatable` переносятся с интерполяцией: `linear`, `hold`, cubic-bezier → bezier с temporal ease (скорость и влияние из контрольных точек);
- громкость клипа × громкость дорожки → Audio Levels в дБ (ключи — линейно по дБ); muted → звук выключен, hidden → слой выключен, locked → слой заблокирован; `blendMode` — режим наложения;
- маркеры клипа (source time → время композиции через ту же функцию времени), секции клипа (маркер с длительностью `section: <label> energy=…`) и эффекты клипа (маркер с длительностью `fx: <id> (<имя>) <параметр>=<значение>… | env a/h/d <curve>`, `[off]` у выключенных) — маркеры слоя;
- fx-дорожка с эффектами → adjustment-слой «FX: <имя дорожки>» на всю композицию с маркерами эффектов; шейдеры не переносятся;
- маркеры и секции проекта — маркеры композиции.

## 9. Сохранение проекта

- Фронт держит проект в памяти; автосейв `PUT /projects/{id}` через 2 с после последнего изменения и при закрытии вкладки.
- Бэк пишет `data/projects/{id}.json` атомарно (tmp + rename), хранит 20 последних версий в `data/projects/{id}.history/`.
- 409 при несовпадении `revision` → фронт показывает «проект изменён в другом окне» (перезагрузить / перезаписать).
