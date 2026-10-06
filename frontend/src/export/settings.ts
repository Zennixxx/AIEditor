import type { Project } from '@/shared/types.gen'

export type ResolutionPreset = 'project' | '720p' | '1080p' | '4k'
export type VideoCodecId = 'avc' | 'hevc' | 'vp9' | 'av1'
export type BitrateMode = 'variable' | 'constant'
export type RangeMode = 'all' | 'inout'

export interface ExportSettings {
  resolution: ResolutionPreset
  fps: number
  codec: VideoCodecId
  bitrateMbps: number
  bitrateMode: BitrateMode
  range: RangeMode
  fileName: string
}

export interface TimeRange {
  start: number
  end: number
}

export const EXPORT_FPS = [24, 25, 30, 50, 60] as const

export const RESOLUTIONS: { value: ResolutionPreset; label: string; shortSide?: number }[] = [
  { value: 'project', label: 'Как в проекте' },
  { value: '720p', label: '720p', shortSide: 720 },
  { value: '1080p', label: '1080p', shortSide: 1080 },
  { value: '4k', label: '4K', shortSide: 2160 },
]

export const CODEC_LABELS: Record<VideoCodecId, string> = {
  avc: 'H.264 (AVC)',
  hevc: 'H.265 (HEVC)',
  vp9: 'VP9',
  av1: 'AV1',
}

const MIN_MBPS = 1
const MAX_MBPS = 200

function even(n: number): number {
  return Math.max(2, Math.round(n / 2) * 2)
}

export function outputSize(
  p: Pick<Project, 'width' | 'height'>,
  resolution: ResolutionPreset,
): { width: number; height: number } {
  const target = RESOLUTIONS.find((r) => r.value === resolution)?.shortSide
  if (!target) return { width: even(p.width), height: even(p.height) }
  const k = target / Math.min(p.width, p.height)
  return { width: even(p.width * k), height: even(p.height * k) }
}

export function exportRange(
  p: Pick<Project, 'duration'>,
  mode: RangeMode,
  inPoint: number | null,
  outPoint: number | null,
): TimeRange {
  if (mode === 'all') return { start: 0, end: p.duration }
  const start = Math.max(0, inPoint ?? 0)
  const end = outPoint ?? p.duration
  return { start, end: Math.max(start, end) }
}

export function frameCount(range: TimeRange, fps: number): number {
  return Math.max(0, Math.ceil((range.end - range.start) * fps - 1e-6))
}

export function frameTime(range: TimeRange, fps: number, i: number): number {
  return range.start + i / fps
}

export function defaultBitrateMbps(width: number, height: number, fps: number): number {
  const ratio = (width * height * fps) / (1920 * 1080 * 30)
  return clampBitrate(Math.round(16 * ratio))
}

export function clampBitrate(mbps: number): number {
  if (!Number.isFinite(mbps)) return MIN_MBPS
  return Math.min(MAX_MBPS, Math.max(MIN_MBPS, mbps))
}

export function sanitizeFileName(name: string, ext = '.mp4'): string {
  const base = [...name]
    .filter((c) => c.charCodeAt(0) >= 32 && !'\\/:*?"<>|'.includes(c))
    .join('')
    .trim()
    .replace(/[. ]+$/, '')
  const stem = base.toLowerCase().endsWith(ext) ? base.slice(0, -ext.length).trim() : base
  return `${stem || 'export'}${ext}`
}

export function defaultExportSettings(
  p: Pick<Project, 'name' | 'fps' | 'width' | 'height'>,
  hasInOut: boolean,
): ExportSettings {
  return {
    resolution: 'project',
    fps: p.fps,
    codec: 'avc',
    bitrateMbps: defaultBitrateMbps(p.width, p.height, p.fps),
    bitrateMode: 'variable',
    range: hasInOut ? 'inout' : 'all',
    fileName: sanitizeFileName(p.name),
  }
}

export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  const m = Math.floor(s / 60)
  const h = Math.floor(m / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m % 60).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} КБ`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} МБ`
  return `${(bytes / 1024 ** 3).toFixed(2)} ГБ`
}
