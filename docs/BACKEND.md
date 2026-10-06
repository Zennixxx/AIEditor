# Backend — задачи по фазам

Владелец: агент бэка. Папки: `backend/`, `tools/`. Контракт: `docs/CONTRACT.md`.
Отмечай выполненное `[x]`. Каждая фаза заканчивается зелёными `uv run pytest`, `uv run ruff check`, `uv run pyright`.

## Архитектура бэка

```
backend/
├─ pyproject.toml          uv; extras: [stems] → demucs+torch
├─ .env.example            GEMINI_API_KEY, GEMINI_MODEL_FAST, GEMINI_MODEL_PRO, AIEDITOR_DATA_DIR, FFMPEG_PATH, RIFE_PATH
└─ app/
   ├─ main.py              FastAPI, CORS, роутеры, lifespan (проверка бинарников, запуск воркеров)
   ├─ config.py            pydantic-settings
   ├─ models/              gen.py (генерируется из shared/schema), api.py, ops.py (строгий discriminated union EditOp)
   ├─ storage/             paths.py (раскладка data/), assets_repo.py, projects_repo.py, atomic.py
   ├─ jobs/                manager.py (очередь, статусы, отмена, прогресс-троттлинг), events.py (WS-хаб)
   ├─ media/               ffprobe.py, proxy.py, thumbs.py, waveform.py, mezzanine.py, ffmpeg.py (обёртка с парсингом прогресса)
   ├─ audio/               bass.py, beats.py, sections.py, energy.py, stems.py, analysis.py (оркестрация + кэш)
   ├─ video/               motion.py (энергия движения), interpolate.py (RIFE), scenes.py
   ├─ ai/                  client.py (google-genai, ретраи, Files API, кэш), prompts/, summarize.py (проект → компактный контекст),
   │                       clip_analysis.py, music_semantics.py, command.py, auto_edit.py, style_ref.py, validate_ops.py
   ├─ timeremap.py         математика CONTRACT §5.1 (для автоэдита и тестов)
   ├─ export/              ae_jsx.py
   └─ routers/             health, assets, analysis, projects, presets, ai, export, jobs, ws
tests/                     pytest; фикстуры аудио/видео генерируются (синус + клики, цветные кадры ffmpeg lavfi)
```

Раскладка данных (`AIEDITOR_DATA_DIR`, по умолчанию `../data`):
```
data/assets/{assetId}/meta.json, proxy.mp4, audio.m4a, mezzanine.mp4, thumbs.json, thumbs/0.jpg…, waveform.json,
                     analysis/music.json, analysis/clip.json, stems/*.wav
data/assets/{derivedAssetId}/meta.json (с parent), interpolated.mp4, proxy.mp4 — производные ассеты RIFE
data/uploads/        файлы, загруженные через /assets/upload
data/projects/       {id}.json, {id}.history/
data/cache/gemini/   {sha1(запроса)}.json, files.json (сопоставление файл → Gemini file URI + срок жизни)
data/presets.json
```

Правила:
- Сервер слушает только `127.0.0.1:8765`.
- Всё долгое — через `jobs.manager`: CPU-задачи в `ProcessPoolExecutor` (librosa), внешние процессы (ffmpeg, rife) — `asyncio.create_subprocess_exec` с отменой (kill дерева процессов).
- Ограничение параллелизма: ffmpeg ≤ 2, rife ≤ 1, gemini ≤ 4 одновременно.
- Ответы API валидируются моделями, сгенерированными из `shared/schema`; тест-контракт сверяет каждый эндпоинт с `shared/fixtures`.
- Логи в `data/logs/backend.log` (ротация), без ключей API.

---

## Фаза 0 — Фундамент

- [x] `uv init`, зависимости: fastapi, uvicorn[standard], pydantic, pydantic-settings, numpy, scipy, librosa, soundfile, google-genai, python-multipart, httpx; dev: pytest, pytest-asyncio, ruff, pyright, datamodel-code-generator.
- [x] Скрипт `uv run gen-models` (datamodel-code-generator из `../shared/schema` → `app/models/gen.py`).
- [x] `tools/fetch_binaries.ps1`: скачивает ffmpeg (gyan.dev essentials) и rife-ncnn-vulkan (последний релиз с GitHub, модели внутри архива) в `tools/bin/`. Скрипт сохранён в UTF-8 с BOM — иначе Windows PowerShell 5.1 ломает кириллицу.
- [x] `/health` с проверкой бинарников и наличия ключа Gemini.
- [x] `jobs.manager` + `/jobs/{id}` + `DELETE` + WS `/ws` (событие `hello`, затем `job`/`asset`).
- [x] Тест: задача-пустышка проходит queued → running → done с прогрессом по WS (`POST /api/debug/sleep-job`, только при `AIEDITOR_DEBUG=1`).

✅ Фаза 0 закрыта 2026-10-05: pytest/ruff/pyright зелёные; `tests/test_shared_contract.py` валидирует все фикстуры и реестры по схеме.

## Фаза 1 — Медиа

- [x] `/assets/import` (пути) и `/assets/upload` (multipart, стриминг на диск). ID по CONTRACT §1; повторный импорт того же файла возвращает существующий ассет.
- [x] ffprobe → `Asset` (kind, duration, width/height, fps из `r_frame_rate`, codec, hasAudio, rotation-метаданные учесть в width/height).
- [x] `browserDecodable`: true для h264 (8-bit, yuv420p), vp9, av1; hevc — true (Windows с расширением HEVC), но mezzanine всё равно делать при 10-bit; prores/dnxhd/прочее — false.
- [x] Цепочка задач после импорта видео: proxy → thumbs → waveform (если есть звук) → mezzanine (если нужно). Для аудио: audio.m4a → waveform.
  - proxy: `-vf scale=-2:720 -c:v libx264 -preset veryfast -crf 23 -g 10 -bf 0 -pix_fmt yuv420p -c:a aac -b:a 192k -movflags +faststart`; для VFR-исходников `-fps_mode cfr -r <round(fps)>`.
  - thumbs: 1 кадр/с (≤ 600 шт; для длинных — шаг больше), тайл 160×90, атласы 10×10 JPG q=80.
  - waveform: моно 22050 Гц, пики min/max на 256 сэмплов, int8.
  - mezzanine: полное разрешение, `-crf 16 -preset medium -pix_fmt yuv420p`.
  - [x] audio.m4a — отдельная задача kind `audio` (CONTRACT v1.2): у видео со звуком proxy → thumbs → audio → waveform → mezzanine, у аудио audio → waveform.
- [x] Прогресс ffmpeg из `-progress pipe:1` (out_time_us / duration).
- [x] Отдача файлов с Range (`206 Partial Content`), корректные `Content-Type`, `Accept-Ranges`.
- [x] Событие WS `asset` при каждом новом производном файле.
- [x] Тесты: импорт сгенерированного 5-секундного видео (lavfi testsrc + sine), все производные созданы, Range-запрос отдаёт 206.

### 1.x Проекты (CONTRACT §8–9)
- [x] `storage/atomic.py`: запись tmp + `os.replace`; `storage/projects_repo.py`.
- [x] `GET /projects` (`{id,name,updatedAt}[]`, сортировка по `updatedAt` desc), `POST /projects` (`{name,fps,width,height}` → пустой `Project` с `revision: 0`), `GET /projects/{id}` (404 `project_not_found`).
- [x] `PUT /projects/{id}`: тело валидируется по схеме; `revision` в теле ≠ текущему → 409 `revision_conflict` (в `details` — текущий `revision`); иначе `revision+1`, `updatedAt` = сейчас, атомарная запись, предыдущая версия → `data/projects/{id}.history/{revision}.json`, хранить 20 последних.
- [x] Тесты: создание → чтение → сохранение (revision растёт) → 409 при устаревшем revision → история обрезается до 20; ответ совпадает по форме с `shared/fixtures/project.json`.

✅ Фаза 1 закрыта 2026-10-05: pytest/ruff/pyright зелёные (медиа-тесты требуют ffmpeg: `tools/bin`, `FFMPEG_PATH`/`FFPROBE_PATH` или PATH, иначе skip). Детали реализации:
- `media/ffmpeg.py` — `subprocess.Popen` + потоки, а не `asyncio.subprocess`: uvicorn с `--reload` на Windows работает на SelectorEventLoop. Отмена корутины убивает процесс.
- `JobManager.submit(depends_on=[…])`: шаги цепочки ждут предыдущий, не занимая слот ресурса; ошибка шага не роняет следующий (вход берётся из оригинала). Статус ассета `ready`/`failed` выставляет сторож после всех шагов (+ WS `asset`); прерванный импорт продолжается при старте.
- audio.m4a — задача kind `audio` (CONTRACT v1.2); waveform строится из audio.m4a, а если его нет — из оригинала.
- `/assets/upload` принимает поля `files[]` и `files`; файл кладётся в `data/uploads/{sha1[:16]}/{имя}` — повторная загрузка того же содержимого даёт тот же ассет.
- Проекты: `PUT` с `id` в теле ≠ пути → 400 `project_id_mismatch`; `createdAt` хранит сервер.

## Фаза 2 — Анализ музыки

- [x] `audio/bass.py`: загрузка моно 22050 → Butterworth LP 4-го порядка `sosfiltfilt` на `bassCutoffHz` → `librosa.onset.onset_strength(hop=256)` → `onset_detect(delta = 0.02 + (1 − sensitivity)·0.3, wait = minGap·sr/hop)` → `strength` = значение огибающей, нормализованное по 99-му перцентилю, обрезано до 1. С `useStems` — то же на стеме drums+bass.
- [x] Уточнение времени: для каждого онсета — поиск максимума производной RMS в окне ±20 мс, чтобы маркер вставал на атаку, а не на пик.
- [x] `audio/beats.py`: `librosa.beat.beat_track` → `bpm`, `beats`; даунбиты — эвристика: фаза из 4, у которой сумма силы баса максимальна (опционально madmom, если ставится на Windows — проверить, иначе не тянуть).
- [x] `audio/energy.py`: RMS-кривая с интервалом 0.1 с, нормализована 0..1.
- [x] `audio/sections.py`: самоподобие по chroma+MFCC (`librosa.segment.recurrence_matrix` + `agglomerative`, k по длине трека) → границы, выровненные к ближайшему даунбиту; метки по энергии: самая энергичная устойчивая секция(и) — `drop`, перед drop с растущей энергией — `build`, первая — `intro`, последняя — `outro`, низкая энергия в середине — `break`, остальное — `verse`.
- [x] `onsets`: широкополосные `onset_detect` с пониженной чувствительностью.
- [x] Кэш: `analysis/music.json` + хэш параметров; повторный запрос с теми же параметрами — мгновенно.
- [x] `/assets/{id}/stems` — Demucs `htdemucs` (только если установлен extra `[stems]`, иначе 501 `demucs_not_installed`); на CPU предупредить о времени в `message` задачи.
- [x] Тесты на синтетике: клик-трек 120 BPM с бас-ударами на каждой доле → bpm 120±1, ≥ 95% бас-маркеров в пределах ±15 мс от истинных; трек тихо/громко/тихо → секция с большей энергией помечена `drop`.
- [x] Производительность: 3-минутный трек < 10 с без стемов.

✅ Фаза 2 закрыта 2026-10-05: pytest (78) / ruff / pyright зелёные; 3-минутный синтетический трек — 3.0 с (декодирование ffmpeg + весь DSP, без стемов). Детали реализации:
- Эндпоинты: `POST /analysis/music/{id}` (частичные параметры, тело необязательно), `GET /analysis/music/{id}` (404 `analysis_not_found`), `POST /assets/{id}/stems` + `GET /assets/{id}/stems/{drums|bass|other|vocals}.wav`; неизвестный ассет — 404 `asset_not_found`; видео без звука/изображение — 422 `no_audio`; `useStems=true` или stems без Demucs — 501 `demucs_not_installed` (проверяется до постановки задачи).
- `audio/dsp.py: analyze_file` — единая точка входа для `ProcessPoolExecutor` (через `ctx.run_cpu`): аудио декодируется ffmpeg в моно 22050 (m4a/видео тоже), остальные модули (`bass`, `beats`, `energy`, `sections`) — чистая DSP. `audio/analysis.py` — параметры по умолчанию, кэш `analysis/music.json` (`{paramsHash, analysis}`, хэш включает `ALGO_VERSION`), дедупликация одинаковых одновременных запросов; повтор с теми же параметрами отдаёт результат из кэша (`message: "Из кэша"`). `GET` отдаёт последний посчитанный анализ.
- Уточнение времени: окно максимума производной RMS — асимметричное, [−45 мс, +20 мс] вместо ±20 мс: онсет по спектральному потоку (окно STFT) приходит раньше атаки. На синтетике смещение маркера −1…−2.5 мс, 100% бас-ударов в пределах ±15 мс.
- Темп: `beat_track(trim=False)` (иначе тихие начало/конец теряют доли), `bpm` из медианного интервала долей; доли подтягиваются к ближайшему онсету (≤ 35 мс). Даунбиты — фаза из 4 с максимальной средней силой баса.
- Секции: chroma_stft+MFCC+громкость, синхронизация по долям, `recurrence_matrix`+`nn_filter` сглаживают только тембр (громкость не сглаживается), `agglomerative` с k = clip(длина/30 с, 3, 10); границы выравниваются к даунбитам, секции < 4 с и соседние с разницей энергии < 0.06 сливаются. Метки: drop (энергия ≥ 0.85·макс, контраст ≥ 0.12) > intro (первая) > outro (последняя) > build (перед drop, энергия растёт) > break (≤ 0.5·макс) > verse. Секции покрывают [0, длительность] без пропусков.
- Стемы: `audio/stems.py` — `python -m demucs -n htdemucs` подпроцессом (отмена убивает процесс), результат `stems/*.wav`; с `useStems` бас/онсеты считаются по миксу drums+bass (`analysis/rhythm.wav`), в ответе `stems.drums/bass`. На CPU в `message` задачи предупреждение. Demucs в окружении не установлен — ветка со стемами не прогонялась (только 501).
- Известные ограничения: даунбит-фаза эвристическая (на равномерных синтетических битах может сместиться на долю — граница секции тогда уходит до 0.5 с); madmom не использован.
- Изменений контракта не требуется.


## Фаза 3 (параллельно фронту) — Подготовка видео-анализа

- [x] `video/motion.py`: энергия движения — ffmpeg из прокси в 160×90 gray @ 10 fps → numpy, среднее абсолютной разницы кадров, сглаживание, нормализация → `ClipAnalysis.motion`.
- [x] `video/scenes.py`: склейки внутри исходника (разница гистограмм) → границы shots (тип плана заполнит Gemini).
- [x] `/analysis/clip/{id}` отдаёт то, что есть (motion + scenes) даже без Gemini.

✅ Фаза 3 бэка закрыта 2026-10-05: pytest (90) / ruff / pyright зелёные. Детали:
- `video/frames.py` — один проход ffmpeg (`fps=10,scale=160:90,format=gray` → rawvideo pipe) для движения и склеек; источник — `proxy.mp4` (CFR), иначе оригинал. `video/analysis.py: ClipAnalysisService` — задача `clipAnalysis` (ресурс `ffmpeg`), кэш `analysis/clip.json`.
- Склейки: L1-расстояние 32-бинных гистограмм > 0.4, шоты короче 0.3 с склеиваются (вспышка в один кадр — не склейка); точность границы — 0.1 с. Шоты покрывают [0, duration], `type: "other"`.
- Движение: средняя |разница| соседних кадров, кадры на склейках не считаются движением, сглаживание окном 3, нормализация по 99-му перцентилю с полом 0.003 (статичное видео остаётся ≈ 0).
- Запуск: автоматически после proxy при импорте (параллельно цепочке, `Asset.status` не ждёт) и при старте для готовых видео без `clip.json`. Gemini-часть (фаза 7) дополнит тот же файл.
- Контракт: уточнение v1.4.3 (только документация).

## Фаза 4 — Пресеты эффектов

- [x] `GET /presets` → `EffectPreset[]` из `data/presets.json` (`{version, presets}`; файла нет → пустой список); `POST /presets` → созданный пресет с `id` (атомарная запись).
- [x] Валидация пресета: каждый `effect` существует в `shared/effects.json`, параметры — известные ключи в диапазонах `min..max`, `enum` — из `options`; ошибка → 422 `invalid_preset` с перечнем в `details`.
- [x] При старте: `shared/effects.json` и `shared/styles.json` валидируются (уникальные id, дефолты в диапазонах, эффекты стилей существуют в реестре); ошибка — в лог и в `/health` не роняет сервер.
- [x] Тесты: CRUD пресетов, отказ на неизвестном эффекте/параметре вне диапазона.

✅ Фаза 4 бэка закрыта 2026-10-05: pytest (104) / ruff / pyright зелёные. Детали:
- `effects/registry.py` — загрузка и проверка `effects.json` / `styles.json` (`Settings.aieditor_shared_dir`), правила значений параметров (число в `min..max`, boolean, цвет `#rrggbb[aa]`, enum из `options`) — общие для старта и пресетов. Ошибки — в лог и `/health.registryErrors`.
- `storage/presets_repo.py` — `data/presets.json` `{version, presets}`, атомарная запись под блокировкой, прочие ключи файла сохраняются (место под стили фазы 7.6); битый файл переносится в `presets.broken-<время>.json`.
- `POST /presets` принимает `CreateEffectPresetRequest`, id `pst_…`; 422 `invalid_preset` (`details.errors`). Контракт v1.5.

## Фаза 5 — Интерполяция (RIFE)

- [x] `video/interpolate.py`: для `[sourceIn, sourceOut]` и `factor`:
  1. извлечь кадры диапазона из оригинала (или mezzanine) в PNG (`-vsync passthrough`, с точными PTS; масштаб — полное разрешение, опция ограничить 1080p);
  2. `rife-ncnn-vulkan -i in -o out -m rife-v4.6 -n <count·factor> -j 1:2:2` (для factor=2ⁿ можно и итеративно);
  3. собрать H.264 `-r fps·factor -crf 16 -g 10`, **с таймстемпами, начинающимися с `sourceIn`** (через `-output_ts_offset sourceIn`) — чтобы source time совпадал с родителем;
  4. зарегистрировать производный ассет (`parent`), сделать для него proxy (720p) — фронт берёт его в превью;
  5. удалить временные кадры.
- [x] Кэш по (assetId, sourceIn, sourceOut, factor) с округлением до кадра; перекрывающиеся запросы с бо́льшим диапазоном — новый ассет.
- [x] Прогресс: по числу готовых кадров в выходной папке.
- [x] Fallback без GPU/RIFE: `minterpolate=fps=…:mi_mode=mci:mc_mode=aobmc:vsbmc=1` (флаг в результате `quality: "fallback"`).
- [x] Отмена убивает процесс и чистит временные файлы.
- [x] `app/timeremap.py` по CONTRACT §5.1 + тест на `shared/fixtures/time_remap_vectors.json` (сделано в фазе 0) (бэк — **генератор эталонных векторов**: скрипт `uv run gen-ramp-vectors`, оркестратор кладёт результат в `shared/fixtures`).
- [x] Тест: 1-секундный клип 30 fps, factor 4 → ассет 120 fps, длительность 1 с ± 1 кадр, первый PTS = sourceIn.

✅ Фаза 5 бэка закрыта 2026-10-06: pytest (124) / ruff / pyright зелёные. Детали:
- `POST /assets/{id}/interpolate` → `InterpolationService` (`video/interpolate.py`), задача `interpolate` на ресурсе `rife` (≤ 1). Диапазон квантуется к кадрам исходника (`floor`/`ceil`), ID производного детерминирован: sha1(родитель|первый|последний кадр|factor). Ассет лежит рядом с обычными: `data/assets/{id}/meta.json` + `interpolated.mp4` (`/original`) + `proxy.mp4`, `parent.quality: "rife" | "fallback"` (контракт v1.7).
- Кадры: `-ss` на полкадра раньше первого + `-frames:v`, PNG без пересэмплирования (`-fps_mode passthrough`), высота не больше 1080 (`AIEDITOR_INTERPOLATE_MAX_HEIGHT`, 0 — без предела). RIFE v4.6 с `-n count·factor`: выходной кадр `i` — момент `i / factor` входных кадров (проверено на сером градиенте); хвостовые `factor − 1` повторов последнего кадра удаляются, остаётся `(count − 1)·factor + 1`. Сборка — один проход ffmpeg с двумя выходами (полное разрешение CRF 16 и proxy 720p CRF 23, GOP 10, без B-кадров) и `-output_ts_offset` = PTS первого кадра: Chromium (`<video>.currentTime`) и Mediabunny видят те же source time (проверено).
- RIFE нет / упал / кадров не столько — `minterpolate` по тем же PNG (`tpad` на 4 кадра, иначе он теряет конец). Прогресс — по числу PNG в выходной папке; отмена убивает процесс, `.work` удаляется в `finally`.
- Кэш: готовый ассет с тем же factor и покрывающим диапазоном — задача сразу `done`; одинаковый запрос во время работы — тот же `jobId`. Производные ассеты не получают локальный анализ клипа.
- Тесты `tests/test_interpolate.py`: квантование и ошибки диапазона, 1 с × 4 (121 кадр, PTS с `sourceIn`, шаг 1/120, кадры `i·4` совпадают с исходником по яркости, proxy с тем же стартом, Range), кэш вложенного диапазона, fallback без RIFE, отмена с очисткой, 404 / `not_video` / `bad_range` / 422.

## Фаза 6 — Экспорт-поддержка

- [x] Mezzanine (если не сделано в фазе 1) для `!browserDecodable`. _(сделано в фазе 1: `media/mezzanine.py`, шаг цепочки импорта)_
- [x] `export/ae_jsx.py`: генерация ExtendScript для AE: композиция (fps, размер, длительность), импорт оригиналов, слои в порядке дорожек, in/out/startTime, маркеры слоёв и композиции (с комментариями kind/strength), time remap ключами (сэмплирование `src(τ)` с шагом в кадр), позиция/масштаб/поворот с ключами, эффекты — комментариями-маркерами (`fx: shake amount=40`), т.к. 1:1 перенос шейдеров невозможен. Тест: снапшот сгенерированного скрипта для фикстурного проекта.

✅ Фаза 6 бэка закрыта 2026-10-06: pytest (115) / ruff / pyright зелёные. Детали:
- `POST /export/ae-jsx` (`routers/export.py`): тело — `Project`, ответ — `text/javascript; charset=utf-8` с `Content-Disposition: attachment; filename*=UTF-8''…` (CORS отдаёт этот заголовок); ошибка тела — 422 `validation_error`.
- Скрипт = `var DATA = {…};` (вся математика посчитана на бэке, только ASCII — `\uXXXX`) + интерпретатор `export/ae_prelude.js` (ES3; в тестах проверяется `node --check`, если node есть). Интерпретатор: композиция и папка, импорт оригиналов (нет файла — серый solid и `alert` со списком), слои снизу вверх, `startTime/inPoint/outPoint`, time remap (2 ключа при постоянной скорости/reverse, ключ на каждый кадр при `timeRemap` — `timeremap.source_time`), якорь, позиция (разделённые X/Y), масштаб с cover-множителем (считается в AE по размеру слоя), поворот, непрозрачность; ключи `linear`/`hold`/bezier с temporal ease из контрольных точек cubic-bezier; Audio Levels в дБ; blend; enabled/audio/locked; маркеры слоя (маркеры клипа — обратным отображением source → время композиции, секции и эффекты клипа — маркеры с длительностью); fx-дорожки — adjustment-слои с маркерами эффектов; маркеры и секции проекта — маркеры композиции.
- Тесты `tests/test_ae_jsx.py`: снапшот `tests/snapshots/ae_jsx_project.jsx` для `shared/fixtures/project.json` (обновление — `AIEDITOR_UPDATE_SNAPSHOTS=1`), порядок слоёв, time remap (постоянная скорость, reverse, покадровые ключи против эталона §5.1, обратное отображение маркеров), ease-ключи, дБ, эндпоинт и 422. В самом After Effects скрипт не запускался (AE в окружении нет).
- Контракт: v1.6 (только документация, CONTRACT §8.3).

## Фаза 7 — Gemini

### 7.1 Клиент (`ai/client.py`)
- [x] `google.genai.Client()` (ключ из env), модели из `GEMINI_MODEL_FAST` / `GEMINI_MODEL_PRO`.
- [x] Загрузка медиа через Files API с ожиданием состояния `ACTIVE`; сопоставление «хэш файла → file URI» в `cache/gemini/files.json` с учётом срока жизни (48 ч) — перезагрузка при истечении.
- [x] Для видео грузится **прокси**, при длине > 3 мин — низкое разрешение медиа (`media_resolution` low) и/или нарезка на куски по 3 мин с переводом таймкодов. Сделано: `upload_video` (прокси, low > 180 с); нарезка на куски — не делалась, решится в 7.2 по результатам на длинных видео.
- [x] Структурированный вывод: `response_mime_type="application/json"`, `response_schema=<Pydantic>`; `resp.parsed`.
- [x] Ретраи с экспоненциальной задержкой на 429/5xx (до 5), таймауты, лог токенов (`usage_metadata`).
- [x] Кэш ответов по sha1(модель + промпт + ID файлов + версия промпта).
- [x] Тесты — с фейковым клиентом (интерфейс `LLM` с методом `generate(schema, parts)`), без сети. Один опциональный интеграционный тест под флагом `--gemini`.

### 7.2 Анализ клипа (`/ai/analyze-clip`)
- [ ] Промпт: «Ты ассистент монтажёра эдитов. Найди моменты, подходящие для эдита: экшен, резкие движения, эмоции, красивые планы…», вход — видео + длительность + список shots из `scenes.py`.
- [ ] Схема ответа: `summary`, `moments[{start,end,score,tags,description}]`, `shotTypes[{start,end,type}]`.
- [ ] Постобработка: обрезать таймкоды в [0, duration]; уточнить границы момента по `motion` (расширить до локального минимума движения в пределах ±0.5 с); слить с motion/scenes → `ClipAnalysis`.

### 7.3 Семантика музыки (`/ai/analyze-music`)
- [ ] Вход: аудио (`audio.m4a`) + DSP-секции с таймкодами + bpm. Gemini **только переименовывает/описывает** секции и может предложить слить/разделить по существующим даунбитам; новые таймкоды не принимаются, если не совпадают с даунбитом ±0.2 с.

### 7.4 Копилот (`/ai/command`)
- [x] `ai/summarize.py`: проект → компактный текст/JSON: дорожки, клипы (id, ассет, start, duration, есть ли ramp, эффекты), маркеры сгруппированы (количество по видам/секциям + список только в выделенном диапазоне или ≤ 200 сильнейших), секции, выделение, плейхед, реестр эффектов (id + aiHint + параметры с диапазонами), пресеты ramp.
- [x] Системный промпт: роль, правила (предпочитать макро-ops `applyEffectToMarkers`/`cutToMarkers`, не выдумывать ID, время в секундах timeline, если команда неоднозначна — вернуть пустой ops и вопрос в `explanation`).
- [x] Схема для Gemini: ~~плоская `GeminiOp {op: enum, ...все поля опциональны}`~~ union моделей по `op` с плоскими полями и обязательными полями (DECISIONS #11) → нормализация в плоский `GeminiOp` → конвертация в строгий `EditOp` (`models/ops.py`).
- [x] `ai/validate_ops.py`: проверка ссылок, диапазонов параметров по `effects.json`, инвариантов через «сухой» прогон на копии проекта (порт примитивных ops на Python), при ошибке — одна повторная попытка с текстом ошибок, затем ответ с `warnings`.
- [x] Фикстура `shared/fixtures/ai_commands.json` (10 команд + ожидаемые типы ops) — тест с фейковым LLM и опциональный живой.

✅ 7.1 и 7.4 закрыты 2026-10-06: pytest / ruff / pyright зелёные; живой прогон `uv run pytest tests/test_ai_command.py -k live --gemini` — 10 из 10 эталонных команд дают ожидаемые типы ops без `warnings` (gemini-flash-latest, ~15 с на команду). Детали:
- `ai/client.py`: протокол `LLM` (`generate(schema, parts, system, tier, prompt_version)`, `upload`), `GeminiClient` (async `client.aio`, семафор ≤ 4, `wait_for` 180 с, ретраи 1/2/4/8 с на 429/5xx/таймауты/сетевые ошибки, лог токенов, фолбэк `resp.text` → `model_validate_json`), кэш ответов `cache/gemini/{sha1}.json` (модель + версия промпта + схема + system + тексты + хэши файлов), `FileRegistry` (`files.json`: sha1 содержимого → URI, перезагрузка за 1 ч до истечения, чистка истёкших), ожидание `ACTIVE`/`FAILED`; `create_llm` → `app.state.llm` (без ключа — `None`).
- `ai/timeline.py`: порт времени клипа, секций в timeline time и `MarkerFilter` с фронта; `ai/validate_ops.py`: `DryRun` — примитивные ops как `applyOps.ts` (кроме точного раздела ключей transform/timeRemap при `splitClip`), макро-ops проверяются (реестр, фильтр, `no_markers`/`no_slots`/`slots_overlap`, ссылки) и оставляют правдоподобный результат для следующих ops; `finalize` + инварианты §2.
- `ai/summarize.py`: дорожки (> 60 элементов — выделенные и ±15 с от плейхеда), музыка (счётчики по видам и секциям, квантили силы басов, маркеры в диапазоне выделенных клипов или ≤ 200 сильнейших без onset), секции, маркеры проекта, реестр, пресеты ramp; `ai/prompts/command.md` — системный промпт.
- `ai/gemini_ops.py`: схема ответа, перевод параметров по типам реестра (число вне диапазона — к границе с предупреждением, неизвестный ключ — отбрасывается), дефолты (`newFxTrack`, огибающая и длительность из реестра, `addClip` целиком из ассета, `updateClip` пересчитывает `duration` при смене скорости/диапазона), `removeMarkers` по фильтру (+ `max_strength`) раскрывается в ID на бэке.
- `ai/command.py` + `routers/ai.py`: `POST /ai/command` — одна повторная попытка с ошибками, затем отбрасывание невалидных ops в `warnings`; 503 `gemini_not_configured`, 502 `gemini_failed`.
- Тесты: `tests/test_ai_client.py` (фейковый genai), `tests/test_ai_command.py` (10 команд фикстуры на `FakeLLM`, повтор, пропуск, инварианты, сериализация, сводка, фильтр, сухой прогон, эндпоинт; живой — `--gemini`), `tests/fake_llm.py`.
- Контракт: v1.8 (только документация, CONTRACT §8.2, §8.4).

### 7.5 Автоэдит (`/ai/auto-edit`)
Гибрид: детерминированный каркас + Gemini для выбора.
- [ ] Шаг 1 — слоты: по `StylePreset.cutDensity` для каждой секции выбрать маркеры музыкального клипа → интервалы между ними = слоты (timeline time). Слоты короче 2 кадров сливаются.
- [ ] Шаг 2 — кандидаты: моменты из `ClipAnalysis` всех выбранных ассетов (если анализа нет — запустить его в рамках задачи; без Gemini — окна с высокой motion-энергией).
- [ ] Шаг 3 — Gemini (Pro): вход — список слотов (id, длительность, секция, сила маркера) + список моментов (id, длительность, score, tags, description) + стиль; выход — `assignments[{slotId, momentId, reason}]` + `effectSuggestions[{effect, sectionLabels, kinds, every, minStrength}]` + `ramps[{slotId, preset}]`. Правила в промпте: самые сильные моменты — в дроп, не повторять момент подряд, ramp на длинные слоты.
- [ ] Шаг 4 — сборка: для каждого слота — `sourceIn/Out` вокруг центра момента под длительность слота; если момент короче слота — `timeRemap` (stretch) или растянуть окно; ramps из ответа → `setTimeRemap`; эффекты: правила стиля × `intensity` + предложения Gemini → макро `applyEffectToMarkers`; переходы на границах секций.
- [ ] Шаг 5 — валидация (7.4) → `OpsResult` с `explanation` (кратко: сколько слотов, какие эффекты, где ramp).
- [ ] Фолбэк без Gemini: жадное назначение по score и энергии секции — автоэдит работает и без ключа.
- [ ] Тест: 3 синтетических ассета + клик-трек → нет перекрытий, все стыки на маркерах (±1 кадр), каждый `sourceOut ≤ duration`.

### 7.6 Стиль по референсу (`/ai/style-from-reference`)
- [ ] DSP по референсу: склейки (`scenes.py`) + бас-маркеры его аудио → фактическая плотность склеек по секциям и доля склеек на басах.
- [ ] Gemini (Pro) по видео: какие эффекты видны (из списка реестра), где замедления, переходы → `StylePreset` (поля плотности берутся из DSP, а не из модели).
- [ ] Сохранение в `data/presets.json` как пользовательский стиль.

## Фаза 8 — Сборка

- [ ] PyInstaller onedir `aieditor-backend.exe` (+ tools/bin), запуск с `--port`, `--data-dir`; graceful shutdown по сигналу от Tauri.
- [ ] `POST /settings/gemini-key` — сохранить ключ в Windows Credential Manager (`keyring`), не в файл.
- [ ] Очистка кэша: `DELETE /cache?older_than_days=30` (прокси/интерполяции неиспользуемых ассетов).
- [ ] `/health` расширить: версия GPU/Vulkan для RIFE, свободное место на диске.
