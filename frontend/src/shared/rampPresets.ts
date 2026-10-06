import type { RampPreset, RampPresetsFile } from '@/shared/types.gen'
import presetsJson from '@shared/fixtures/ramp_presets.json'

export const rampPresets: readonly RampPreset[] = (presetsJson as unknown as RampPresetsFile).presets

export function findRampPreset(id: string): RampPreset | undefined {
  return rampPresets.find((p) => p.id === id)
}
