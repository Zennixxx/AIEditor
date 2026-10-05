# AIEditor

ИИ-ассистент для монтажа эдитов под музыку: слои как в After Effects, автоматические маркеры на бассах, библиотека эффектов (шейк, зум-панч, фликер, RGB-сдвиг…), speed ramp с интерполяцией кадров (RIFE) и ИИ-копилот на Gemini.

## Быстрый старт (Windows)

Нужны Node.js 22+, [uv](https://docs.astral.sh/uv/), Python 3.12.

```powershell
npm run setup                      # зависимости + ffmpeg и rife-ncnn-vulkan в tools/bin
copy backend\.env.example backend\.env   # и вписать GEMINI_API_KEY (необязательно)
npm run dev                        # http://localhost:5173
```

Без бэка: `npm run dev:mock` — фронт на моках из `shared/fixtures`.

## Документация

- [`PLAN.md`](PLAN.md) — архитектура, фазы, как запускать агентов
- [`docs/CONTRACT.md`](docs/CONTRACT.md) — контракт фронт ↔ бэк
- [`docs/FRONTEND.md`](docs/FRONTEND.md), [`docs/BACKEND.md`](docs/BACKEND.md) — задачи по фазам
- [`CLAUDE.md`](CLAUDE.md) — правила для агентов и команды
