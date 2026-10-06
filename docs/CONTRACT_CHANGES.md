# Журнал изменений контракта

Процесс: агент добавляет запись в «Proposed» → оркестратор утверждает → правит `shared/` и `docs/CONTRACT.md`, поднимает `schemaVersion` при несовместимом изменении → переносит запись в «Applied».

Формат записи:

```
### <короткое название>
- Автор: frontend | backend
- Фаза: N
- Что: поле/эндпоинт/op
- Зачем:
- Пример JSON:
- Совместимость: обратная совместимость сохраняется? да/нет
```

## Proposed

_пусто_

## Applied

### v1.9 — фаза 7: ИИ-анализ, автоэдит, стиль по референсу (совместимо)
- Дата: 2026-10-06
- Автор: единый агент
- Что: эндпоинт `GET /presets/styles` → `StylePreset[]` (пользовательские стили, `data/presets.json` → `styles`); CONTRACT §8 — kind задач ИИ-эндпоинтов; §8.2 — коды ошибок `analyze-clip`, `analyze-music`, `auto-edit`, `style-from-reference` (`asset_not_ready`, `not_video`, `no_audio`, `clip_not_found`, `no_markers`, `unknown_style`, `bad_range`); новые §8.5–8.7 — ИИ-анализ клипа и музыки, состав ops автоэдита, расчёт `cutDensity` по референсу.
- Совместимость: да, схема и типы не меняются (`StylePreset` уже есть).

### v1.8 — фаза 7: копилот (только документация)
- Дата: 2026-10-06
- Автор: единый агент
- Что: CONTRACT §8.2 — ошибки `POST /ai/command`: 503 `gemini_not_configured`, 502 `gemini_failed` (`details.reason`); новый §8.4 — гарантии ответа копилота (сухой прогон ops на бэке, одна повторная попытка, отброшенные ops и мягкие исправления в `warnings`, пустой `ops` с вопросом, явный `timeRemap: null`).
- Совместимость: да, схема не меняется.

### v1.7 — фаза 5: интерполяция кадров (совместимо)
- Дата: 2026-10-06
- Автор: единый агент
- Что:
  - `AssetParent.quality?: "rife" | "fallback"` — чем интерполирован производный ассет;
  - CONTRACT §5.3 — квантование диапазона к кадрам исходника, PTS производного ассета (edit list, те же source time в `<video>` и Mediabunny), `duration` производного = конец покрытого source time, proxy 720p, ограничение 1080p, кэш по вложенному диапазону, повтор идущего запроса → тот же `jobId`, условие годности `interpolatedAssetId` для клипа; производные ассеты есть в `GET /assets`;
  - CONTRACT §8.2 — ошибки `POST /assets/{id}/interpolate`: 404 `asset_not_found`, 422 `not_video`, 422 `bad_range`, 503 `ffmpeg_missing`.
- Совместимость: да, `schemaVersion` остаётся 1.

### v1.6 — фаза 6: экспорт (только документация)
- Дата: 2026-10-06
- Автор: единый агент
- Что: CONTRACT §8 — формат ответа `POST /export/ae-jsx` (`text/javascript`, `Content-Disposition: attachment; filename*=UTF-8''…`, CORS отдаёт `Content-Disposition`); новый §8.3 — правила экспорта MP4 в браузере (время кадра, выбор источника, сведение звука, кодеки) и состав скрипта After Effects (слои, time remap, transform, маркеры, эффекты как маркеры). Ошибка тела — 422 `validation_error`, как у остальных эндпоинтов.
- Совместимость: да, схема не меняется.

### v1.5 — фаза 4: эффекты и пресеты (совместимо)
- Дата: 2026-10-05
- Автор: оркестратор (единый агент)
- Что:
  - CONTRACT §2.1 — формула интенсивности эффекта: огибающая (`attack/hold/decay`, кривые `linear`/`easeOut`/`exp`) × параметр `strength`; отсутствующие ключи `params` — дефолты реестра;
  - `shared/effects.json`: параметр `strength` (0..2, 1) добавлен всем эффектам, кроме переходов (`panCrop`, `strobe`, `flash`, `invert`, `glow`, `filmGrain`, `vignette`, `letterbox`, `contrastPunch`, `chromaWave`) — `scaleByStrength` работает единообразно;
  - CONTRACT §6.2 — семантика макро-op `applyEffectToMarkers` (обрезка длительности до следующего маркера, цели, `anchor`, коды `unknown_effect`, `no_markers`, `slots_overlap`, `incompatible_track`, `bad_value`);
  - `POST /presets` принимает `CreateEffectPresetRequest` (`{name, description?, effects}`, без `id`), бэк назначает `pst_…`; `GET /presets` → `EffectPreset[]`; 422 `invalid_preset` с `details.errors`;
  - `Health.registryErrors?: string[]` — ошибки проверки `effects.json` / `styles.json` при старте (сервер не падает);
  - фикстура `shared/fixtures/presets.json` (`EffectPreset[]`) для MSW-моков.
  - CONTRACT §2.1 — правило следования эффектов с `anchor` за маркером (кто сохраняет место, кто едет, обрезка наезда);
  - CONTRACT §1 — уточнение координат кадра: ось y вниз, поворот по часовой стрелке, `anchor` — точка поворота/масштаба (сам слой не сдвигает).
- Совместимость: да, `schemaVersion` остаётся 1 (новые необязательные поле и тип; эффекты без `strength` в старых проектах получают дефолт 1).

### v1.4.4 — фаза 3 фронта: семантика макро-ops (только документация)
- Дата: 2026-10-05
- Автор: frontend
- Что: CONTRACT §6.2 — точная семантика `MarkerFilter`, `cutToMarkers` и `snapClipEdgesToMarkers` (раньше был только тип). Схема не меняется. Коды ошибок макро-ops: `no_slots`, `slots_overlap`, `incompatible_track`, `clip_not_found`, `track_not_found`, `bad_value`. Фронт раскрывает макро-op внутри `applyOps` (контекст `ApplyContext.clipAnalysis` — для `bestMoments`).
- Совместимость: да.

### v1.4.3 — фаза 3 бэка (только документация)
- Дата: 2026-10-05
- Автор: backend
- Что: `GET /analysis/clip/{id}` до подключения Gemini (фаза 7) отдаёт локальный анализ: `model: ""`, `summary: ""`, `moments: []`, `shots` — склейки (все `type: "other"`, покрывают клип без пропусков), `motion` — интервал 0.1 с. Анализ запускается автоматически после proxy при импорте видео (задача `clipAnalysis`, не влияет на `Asset.status`) и при старте бэка для видео, у которых его нет; 404 `analysis_not_found`, пока он не готов, и для аудио/изображений. Фронт может ждать готовности опросом GET или по WS `job` kind `clipAnalysis`.
- Совместимость: да.

### v1.4.2 — фаза 2 бэка (только документация)
- Дата: 2026-10-05
- Автор: backend, утвердил оркестратор
- Что: CONTRACT §8.2 — 422 `no_audio` у `POST /analysis/…/{id}` и `/assets/{id}/stems` для ассета без звука; 501 `demucs_not_installed` также у `POST /analysis/music/{id}` с `useStems: true`. Бэк дополнительно отдаёт стемы по `GET /assets/{id}/stems/{drums|bass|other|vocals}.wav` (URL из результата задачи `stems`).
- Совместимость: да.

### v1.4.1 — коды ошибок анализа (только документация)
- Дата: 2026-10-05
- Автор: frontend, утвердил оркестратор
- Что: CONTRACT §8.2 — 404 `analysis_not_found` у `GET /analysis/music|clip/{id}`, 404 `asset_not_found` у `POST /analysis/…/{id}` и `/assets/{id}/stems`, 501 `demucs_not_installed`.
- Совместимость: да.

### v1.4 — подготовка фазы 2 (совместимо)
- Дата: 2026-10-05
- Автор: оркестратор
- Что:
  - `Clip.sections?: Section[]` — секции музыки из анализа в **source time**, едут вместе с клипом (DECISIONS #8). `project.sections` остаётся для секций композиции (ручные / ИИ, timeline time);
  - EditOp += `setSections { target: {clipId} | "project", sections }` — замена списка секций целиком (`SectionInput` в `api.schema.json`); `ClipInput.sections?`;
  - CONTRACT §2 инвариант 8 (секции отсортированы, не перекрываются, ID уникальны в проекте);
  - CONTRACT §4 — точные правила переноса анализа в проект: `beats`/`downbeats` без дублей, strength 1; `onsets` → маркеры `onset`, скрытые по умолчанию; «Переанализировать» заменяет `bass`/`beat`/`downbeat`/`onset` и `clip.sections`;
  - CONTRACT §6.1 п. 9–11 — семантика `setSections`, `splitClip` для секций клипа, snapping и `MarkerFilter.sectionLabels` по секциям клипов;
  - `shared/fixtures/project.json`: секции перенесены из `project.sections` в `clip.sections` музыкального клипа.
- Совместимость: да, `schemaVersion` остаётся 1 (поле и op новые; старые проекты с `project.sections` валидны). Фронту: `setSections` в `applyOps`, `splitClip` для секций, инварианты и lookup ID по `clip.sections`, snapping по секциям клипов, перенос анализа по §4. Бэку: учесть `setSections` и `clip.sections` при сухом прогоне ops (фаза 7).

### v1.3.1 — фаза 1b фронта (только документация)
- Дата: 2026-10-05
- Автор: frontend, утвердил оркестратор
- Что: CONTRACT §6.1 п. 7–8 — семантика `moveTrack.index` и `updateTrack.patch.volume`/`name`.
- Совместимость: да.

### v1.3 — фаза 1a фронта (совместимо)
- Дата: 2026-10-05
- Автор: frontend, утвердил оркестратор
- Что:
  - EditOp += `updateTrack`, `moveTrack` (CONTRACT §6);
  - `Thumbs.rows?` (по умолчанию = `columns`);
  - CONTRACT §6.1 — семантика примитивных ops (split с timeRemap, `setTimeRemap(null)`, ripple remove, `project.duration`, `addClip` с ассетом из библиотеки, инвариант 3 для image).
- Совместимость: да, `schemaVersion` остаётся 1. Фронту: `updateTrack`/`moveTrack` в `applyOps`, перевести заголовки дорожек на них; учитывать `rows`. Бэку: писать `rows` в `thumbs.json`.

### v1.2 — фаза 1 бэка (совместимо)
- Дата: 2026-10-05
- Автор: backend, утвердил оркестратор
- Что:
  - `JobKind` += `"audio"` (извлечение audio.m4a);
  - CONTRACT §8.1 — импорт без задачи `import`, готовность ассета по WS `asset` со `status: "ready"|"failed"`;
  - CONTRACT §8.2 — коды ошибок ассетов, проектов и задач;
  - `shared/fixtures/waveform_music.json`: `samplesPerPeak` 1024 → 256 (как отдаёт бэк).
- Совместимость: да, `schemaVersion` остаётся 1. Бэку: перевести извлечение audio.m4a на задачу kind `audio` (сейчас — `proxy`/`waveform`).

### v1.1 — уточнения фазы 0 (совместимо)
- Дата: 2026-10-05
- Автор: оркестратор
- Что:
  - машиночитаемые схемы `shared/schema/project.schema.json`, `api.schema.json`; реестры `shared/effects.json` (22 эффекта), `shared/styles.json` (5 стилей); фикстуры `shared/fixtures/*`;
  - `applyEffectToMarkers.scaleByStrength`, `cutToMarkers.seed`;
  - `StylePreset.description`, `StylePreset.globalEffects`; определение `EffectPreset`;
  - `JobKind` += `"debug"`, эндпоинт `POST /debug/sleep-job` (только `AIEDITOR_DEBUG=1`);
  - CONTRACT §5.1: точная семантика `hold` и решения cubic-bezier; эталон — `backend/app/timeremap.py`;
  - обёртки файлов: `{version, effects}`, `{version, styles}`, `{version, presets}`, `{version, tolerance, vectors}`.
- Совместимость: да, `schemaVersion` остаётся 1.

### v1 — исходный контракт
- Дата: 2026-10-05
- Содержимое: `docs/CONTRACT.md` целиком.
