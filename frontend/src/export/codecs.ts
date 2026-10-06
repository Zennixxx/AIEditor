import { canEncodeAudio, Quality, type AudioCodec } from 'mediabunny'
import type { BitrateMode, VideoCodecId } from './settings'

export type EncoderConfig = VideoEncoderConfig & { hevc?: { format: 'hevc' | 'annexb' } }

export const VIDEO_CODECS: VideoCodecId[] = ['avc', 'hevc', 'vp9', 'av1']

const CODEC_STRINGS: Record<VideoCodecId, string[]> = {
  avc: [
    'avc1.640034',
    'avc1.640033',
    'avc1.64002A',
    'avc1.640028',
    'avc1.4D0034',
    'avc1.42E034',
    'avc1.42001F',
  ],
  hevc: ['hvc1.1.6.L153.B0', 'hev1.1.6.L153.B0', 'hvc1.1.6.L150.B0', 'hvc1.1.6.L123.B0'],
  vp9: ['vp09.00.51.08', 'vp09.00.41.08', 'vp09.00.31.08'],
  av1: ['av01.0.12M.08', 'av01.0.08M.08', 'av01.0.04M.08'],
}

export interface VideoTarget {
  width: number
  height: number
  fps: number
  bitrate: number
  bitrateMode: BitrateMode
}

export function encoderConfig(codec: VideoCodecId, codecString: string, t: VideoTarget): EncoderConfig {
  const config: EncoderConfig = {
    codec: codecString,
    width: t.width,
    height: t.height,
    framerate: t.fps,
    bitrate: t.bitrate,
    bitrateMode: t.bitrateMode,
    latencyMode: 'quality',
  }
  if (codec === 'avc') config.avc = { format: 'avc' }
  if (codec === 'hevc') config.hevc = { format: 'hevc' }
  return config
}

export async function findEncoderConfig(codec: VideoCodecId, t: VideoTarget): Promise<EncoderConfig | null> {
  if (typeof VideoEncoder === 'undefined') return null
  for (const s of CODEC_STRINGS[codec]) {
    const config = encoderConfig(codec, s, t)
    const res = await VideoEncoder.isConfigSupported(config).catch(() => null)
    if (res?.supported) return config
  }
  return null
}

export async function probeVideoCodecs(t: VideoTarget): Promise<Record<VideoCodecId, EncoderConfig | null>> {
  const configs = await Promise.all(VIDEO_CODECS.map((c) => findEncoderConfig(c, t)))
  return Object.fromEntries(VIDEO_CODECS.map((c, i) => [c, configs[i] ?? null])) as Record<
    VideoCodecId,
    EncoderConfig | null
  >
}

export interface AudioChoice {
  codec: AudioCodec
  bitrate: number
  label: string
}

const AUDIO_OPTIONS: AudioChoice[] = [
  { codec: 'aac', bitrate: 320_000, label: 'AAC 320 кбит/с' },
  { codec: 'aac', bitrate: 256_000, label: 'AAC 256 кбит/с' },
  { codec: 'aac', bitrate: 192_000, label: 'AAC 192 кбит/с' },
  { codec: 'opus', bitrate: 320_000, label: 'Opus 320 кбит/с' },
  { codec: 'opus', bitrate: 192_000, label: 'Opus 192 кбит/с' },
]

export async function pickAudioCodec(sampleRate: number, channels: number): Promise<AudioChoice | null> {
  for (const option of AUDIO_OPTIONS) {
    const ok = await canEncodeAudio(option.codec, {
      numberOfChannels: channels,
      sampleRate,
      quality: new Quality({ bitrate: option.bitrate }),
    }).catch(() => false)
    if (ok) return option
  }
  return null
}

export function mediabunnyQuality(bitrate: number): Quality {
  return new Quality({ bitrate })
}
