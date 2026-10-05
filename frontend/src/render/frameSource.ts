// Источник кадра слоя (FRONTEND.md §4.1): единый интерфейс для превью и экспорта.
// Превью отдаёт <video> из пула плеера (или кадр из атласа thumbs / картинку), экспорт — VideoFrame
// из Mediabunny (фаза 6). Рендереру всё равно, откуда кадр: он загружает `source` в текстуру.
import type { LayerStep } from './framePlan'

export type FrameSourceKind = 'video' | 'thumb' | 'image'

export interface FrameImage {
  kind: FrameSourceKind
  source: TexImageSource
  /** Размер всего источника, px. */
  width: number
  height: number
  /** Область источника (px) — для тайла атласа; по умолчанию весь источник. */
  crop?: { x: number; y: number; w: number; h: number }
  /** Содержимое меняется от кадра к кадру (видео) — загружать в текстуру каждый раз. */
  dynamic: boolean
}

/** Кадр для слоя плана или null (ещё не загружен — слой пропускается). */
export type FrameResolver = (step: LayerStep) => FrameImage | null
