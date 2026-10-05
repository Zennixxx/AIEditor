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
