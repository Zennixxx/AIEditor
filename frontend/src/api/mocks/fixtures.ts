// Типизированный доступ к shared/fixtures для MSW-моков и тестов.
import type {
  AiCommandsFile,
  Asset,
  ClipAnalysis,
  EffectPreset,
  Health,
  Job,
  MusicAnalysis,
  OpsResult,
  Project,
  RampPresetsFile,
  StylesFile,
  Thumbs,
  TimeRemapVectorsFile,
  Waveform,
} from '@/shared/types.gen'
import aiCommandsJson from '@shared/fixtures/ai_commands.json'
import assetsJson from '@shared/fixtures/assets.json'
import clipAnalysisJson from '@shared/fixtures/clip_analysis.json'
import healthJson from '@shared/fixtures/health.json'
import jobsJson from '@shared/fixtures/jobs.json'
import musicAnalysisJson from '@shared/fixtures/music_analysis.json'
import opsResultJson from '@shared/fixtures/ops_result.json'
import presetsJson from '@shared/fixtures/presets.json'
import projectJson from '@shared/fixtures/project.json'
import rampPresetsJson from '@shared/fixtures/ramp_presets.json'
import thumbsJson from '@shared/fixtures/thumbs_video_a.json'
import timeRemapVectorsJson from '@shared/fixtures/time_remap_vectors.json'
import waveformJson from '@shared/fixtures/waveform_music.json'
import stylesJson from '@shared/styles.json'

export const fixtures = {
  health: healthJson as Health,
  assets: assetsJson as Asset[],
  musicAnalysis: musicAnalysisJson as MusicAnalysis,
  clipAnalysis: clipAnalysisJson as ClipAnalysis,
  waveform: waveformJson as Waveform,
  thumbs: thumbsJson as Thumbs,
  project: projectJson as unknown as Project,
  jobs: jobsJson as Job[],
  opsResult: opsResultJson as unknown as OpsResult,
  aiCommands: aiCommandsJson as AiCommandsFile,
  rampPresets: rampPresetsJson as unknown as RampPresetsFile,
  presets: presetsJson as unknown as EffectPreset[],
  timeRemapVectors: timeRemapVectorsJson as unknown as TimeRemapVectorsFile,
  styles: (stylesJson as unknown as StylesFile).styles,
}

/** Глубокая копия, чтобы моки не мутировали общий объект фикстуры. */
export function clone<T>(value: T): T {
  return structuredClone(value)
}
