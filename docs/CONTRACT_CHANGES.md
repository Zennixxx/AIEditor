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

### Семантика `updateTrack` / `moveTrack` (уточнение CONTRACT §6.1)
- Автор: frontend
- Фаза: 1b
- Что: дописать в §6.1 (фронт так уже делает в `applyOps`):
  - `moveTrack.index` — итоговая позиция дорожки в `project.tracks` после переноса; индекс за концом → в конец (как `addTrack.index`); нецелый или < 0 → ошибка `bad_value`;
  - `updateTrack.patch.volume` допустим только у `audio`-дорожки, 0..2; пустое имя → `bad_value`.
- Зачем: бэк в `validate_ops` (сухой прогон) должен давать тот же результат, что `applyOps`.
- Пример JSON: `{ "op": "moveTrack", "trackId": "trk_v1", "index": 99 }` при 4 дорожках ≡ `index: 3`.
- Совместимость: да.

## Applied

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
