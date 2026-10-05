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

### JobKind `audio` для извлечения audio.m4a
- Автор: backend
- Фаза: 1
- Что: `Job.kind` += `"audio"` (извлечение `derived.audio` в AAC).
- Зачем: в `JobKind` нет вида для audio.m4a. Сейчас (временно) у аудиоассетов это задача `proxy` (message «Аудио AAC»), у видео со звуком — часть задачи `waveform`. С отдельным видом фронт сможет подписывать прогресс точнее.
- Пример JSON: `{"id": "job_ab12cd34ef", "kind": "audio", "assetId": "ast_c0ffee1234abcd56", "status": "running", "progress": 0.4, "message": "Аудио AAC", …}`
- Совместимость: да (расширение enum).

### Коды ошибок ассетов и проектов (фаза 1)
- Автор: backend
- Фаза: 1
- Что: задокументировать в CONTRACT §8 коды, которые уже отдаёт бэк:
  `POST /assets/import|upload`: 400 `file_not_found` (`details.paths`), 422 `unsupported_media` (`details.files: {путь: причина}`), 400 `no_files`, 503 `ffmpeg_missing`;
  `GET /assets/{id}…`: 404 `asset_not_found`, 404 `file_not_found` (производный файл ещё не готов);
  `/projects/{id}`: 404 `project_not_found`, 400 `project_id_mismatch` (id в теле ≠ пути), 409 `revision_conflict` (`details.revision` — текущая ревизия).
  Ошибка задачи ffmpeg: `job.error.code = "ffmpeg_failed"`.
- Зачем: фронту нужно различать «файл не найден», «не медиа» и «нет ffmpeg» в UI импорта.
- Пример JSON: `{"error": {"code": "revision_conflict", "message": "Проект изменён в другом окне", "details": {"revision": 7}}}`
- Совместимость: да (только документация).

### Готовность ассета и импорт без задачи `import`
- Автор: backend
- Фаза: 1
- Что: зафиксировать в CONTRACT §3/§8: `POST /assets/import` возвращает ассеты со `status: "importing"` и `jobs` — шаги цепочки (`proxy`, `thumbs`, `waveform`, `mezzanine`). Отдельной задачи kind `import` нет; конец импорта — WS `asset` со `status: "ready"` (или `"failed"`, если не создан proxy у видео / audio.m4a у аудио). Повторный импорт готового ассета → тот же ассет и `jobs: []`; идущего — его текущие задачи. Изображения сразу `ready`, без задач.
- Зачем: фронту однозначный сигнал готовности.
- Пример JSON: `{"type": "asset", "asset": {"id": "ast_…", "status": "ready", "derived": {"proxy": "/api/assets/ast_…/proxy.mp4", …}, …}}`
- Совместимость: да.

### `samplesPerPeak` в фикстуре waveform
- Автор: backend
- Фаза: 1
- Что: `shared/fixtures/waveform_music.json` содержит `samplesPerPeak: 1024`, бэк отдаёт 256 (docs/BACKEND.md, фаза 1). Схема допускает любое значение; предлагаю привести фикстуру к 256, чтобы моки фронта совпадали с реальным ответом по плотности пиков.
- Совместимость: да.

## Applied

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
