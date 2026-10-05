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

### Ops для дорожек: `updateTrack`, `moveTrack`
- Автор: frontend
- Фаза: 1a
- Что: два примитивных op в CONTRACT §6 / `api.schema.json#EditOp`:
  `{ op: "updateTrack"; trackId; patch: Partial<Pick<Track, "name"|"muted"|"locked"|"hidden"|"volume">> }`,
  `{ op: "moveTrack"; trackId; index: number }` (индекс в `project.tracks`, т.е. в порядке отрисовки снизу вверх).
- Зачем: сейчас переименование, mute/lock/hide и перестановка дорожек делаются на фронте через `transact` (запись в истории есть), но ИИ-копилот не может выразить «замьють музыку», «подними FX над V2». Временно: `frontend/src/timeline/TrackHeaders.tsx` + `model/tracks.ts: moveTrackInDisplay`.
- Пример JSON: `{"op":"updateTrack","trackId":"trk_audio00001","patch":{"muted":true}}`, `{"op":"moveTrack","trackId":"trk_fx00000002","index":3}`
- Совместимость: да (новые варианты union).

### `Thumbs.rows` — число строк плиток в одном JPG-атласе
- Автор: frontend
- Фаза: 1a
- Что: необязательное поле `rows: number` в `thumbs.json` (CONTRACT §3, `Thumbs`).
- Зачем: по контракту известно только `columns`; индекс атласа для кадра `i` = `floor(i / (columns·rows))`. Фронт сейчас предполагает квадратные атласы `columns × columns` (так в docs/BACKEND.md: «атласы 10×10») — `frontend/src/store/media.ts: tilesPerSprite`.
- Пример JSON: `{"interval":1,"tileWidth":160,"tileHeight":90,"columns":10,"rows":10,"count":240,"sprites":["/api/assets/ast_…/thumbs/0.jpg","/api/assets/ast_…/thumbs/1.jpg","/api/assets/ast_…/thumbs/2.jpg"]}`
- Совместимость: да (по умолчанию `rows = columns`).

### Уточнения семантики примитивных ops (как реализовано во фронте)
- Автор: frontend
- Фаза: 1a
- Что (текст для CONTRACT §2/§6, схему менять не нужно):
  1. `splitClip` у клипа с `timeRemap`: обе половины получают ключи, обрезанные по `u` и перенормированные в [0,1], и `fit: "stretch"` с точными диапазонами `[sourceIn, src(τ)]` / `[src(τ), sourceOut]` (стык непрерывен). Для `reverse` левая половина берёт конец диапазона исходника. Маркеры клипа уходят в половину, чей source-диапазон их содержит (ID сохраняются, `anchor.clipId` переадресуется); эффекты клипа — по своему `start`; ключи `transform/opacity/volume` делятся с граничным ключом.
  2. `setTimeRemap(null)` сохраняет слот и потреблённый диапазон: `sourceOut` = фактический, `speed = (sourceOut − sourceIn) / duration`.
  3. `removeClip(ripple)` сдвигает влево на `duration` только элементы той же дорожки, начинающиеся не раньше конца удалённого.
  4. `project.duration` пересчитывается после каждой транзакции как максимум `start + duration` по всем элементам дорожек.
  5. `addClip` с `assetId`, которого нет в `project.assets`, копирует метаданные ассета из библиотеки (`GET /assets`), иначе ошибка `asset_not_found`.
  6. Инвариант 3 для `image`: верхняя граница `asset.duration` (= 0) не проверяется; `sourceIn/sourceOut` — условные (`0 … duration·speed`).
- Зачем: бэк (автоэдит, валидация ops копилота) должен ожидать тот же результат.
- Совместимость: да.

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
