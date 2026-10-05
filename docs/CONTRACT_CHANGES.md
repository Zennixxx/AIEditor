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

### Код ошибки `analysis_not_found` в §8.2
- Автор: frontend
- Фаза: 2
- Что: добавить в таблицу §8.2: `GET /analysis/music/{id}` и `GET /analysis/clip/{id}` — HTTP 404, `code: "analysis_not_found"` (анализ ещё не выполнен); `POST /analysis/music/{id}` у неизвестного ассета — 404 `asset_not_found`.
- Зачем: фронт трактует 404 от `GET /analysis/music/{id}` как «анализа нет, запустить задачу» (готовый анализ применяется без задачи); явный код отличает это от «ассет не найден». Моки уже отдают такие коды.
- Пример JSON: `{ "error": { "code": "analysis_not_found", "message": "Анализ ещё не выполнен" } }`
- Совместимость: да (уточнение).

## Applied

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
