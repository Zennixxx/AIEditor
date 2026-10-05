# AIEditor — правила для агентов

ИИ-видеоредактор для эдитов под музыку. Главный план — `PLAN.md`; контракт фронт ↔ бэк — `docs/CONTRACT.md`; задачи — `docs/FRONTEND.md`, `docs/BACKEND.md`.

## Зоны ответственности

| Папка | Владелец | Остальным |
|---|---|---|
| `frontend/` | агент фронта | только читать |
| `backend/`, `tools/` | агент бэка | только читать |
| `shared/`, `docs/CONTRACT.md` | оркестратор | предлагать изменения в `docs/CONTRACT_CHANGES.md` |
| `PLAN.md`, `CLAUDE.md`, `docs/DECISIONS.md` | оркестратор | — |

Агент фазы правит только свою папку и чек-лист своего `docs/*.md`.

## Правила

- Перед работой прочитать `PLAN.md`, `docs/CONTRACT.md` и свой файл задач целиком.
- Типы из `shared/schema` генерируются (`npm run gen:types`, `uv run gen-models`); сгенерированные файлы руками не правятся.
- Не хватает поля/эндпоинта → не обходить контракт, а записать предложение в `docs/CONTRACT_CHANGES.md` (раздел «Proposed»: что, зачем, пример JSON) и временно замокать у себя.
- Времена — секунды (float); timeline time и source time не путать (CONTRACT §1).
- Математика speed ramp (CONTRACT §5.1) — одна на обе стороны, проверяется векторами из `shared/fixtures/time_remap_vectors.json`.
- Ключ Gemini только на бэке, никогда не логировать и не коммитить. `.env` в `.gitignore`.
- Бинарники (`tools/bin/`) и `data/` не коммитятся.
- Фаза закрыта, когда: тесты/линтеры зелёные, пункты отмечены `[x]`, есть отчёт (сделано / отложено / нужные изменения контракта).

## Команды

```
# корень
npm run setup               # первый запуск: npm/uv зависимости + ffmpeg/RIFE в tools/bin
npm run dev                 # фронт (5173) + бэк (8765) вместе
npm run dev:mock            # только фронт, API — MSW-моки по shared/fixtures
npm run gen                 # регенерация типов из shared/schema (Python + TS)
npm run gen:fixtures        # регенерация синтетических фикстур и векторов speed ramp
npm test                    # pytest + vitest
npm run check               # ruff + pyright + tsc + eslint

# frontend/
npm run dev | dev:mock
npm run gen:types
npm run typecheck && npm run lint && npm test
npm run e2e                 # Playwright (сам поднимает dev:mock); браузер: npx playwright install chromium

# backend/
uv run uvicorn app.main:app --host 127.0.0.1 --port 8765 --reload --reload-dir app
uv run gen-models
uv run gen-ramp-vectors     # бэк — генератор эталона shared/fixtures/time_remap_vectors.json
uv run pytest && uv run ruff check && uv run pyright
powershell -ExecutionPolicy Bypass -File ..\tools\fetch_binaries.ps1   # ffmpeg + rife-ncnn-vulkan
```

## Подводные камни

- Сгенерированные модели: поля snake_case + `alias_generator=to_camel`; сериализовать через `model_dump(by_alias=True, exclude_none=True)` (`app/jobs/events.py: dump`), в роутерах — `response_model_exclude_none=True`.
- Фикстуры читаются и фронтом (`src/api/mocks/fixtures.ts`), и бэком (`tests/test_shared_contract.py`) — после изменения схемы прогоняй тесты обеих сторон.
- `.ps1`-файлы сохранять в UTF-8 **с BOM** (Windows PowerShell 5.1).
