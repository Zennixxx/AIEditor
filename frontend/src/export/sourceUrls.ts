import { usableInterpolation } from '@/model/interpolation'
import type { AssetLookup } from '@/playback/timing'
import type { Asset, Clip } from '@/shared/types.gen'

export function originalUrl(asset: Pick<Asset, 'id'>): string {
  return `/api/assets/${asset.id}/original`
}

export function videoCandidates(clip: Clip, asset: Asset, lookup: AssetLookup): string[] {
  const urls: string[] = []
  const interpolated = usableInterpolation(clip, lookup)
  if (interpolated) urls.push(originalUrl(interpolated))
  if (asset.browserDecodable) urls.push(originalUrl(asset))
  if (asset.derived.mezzanine) urls.push(asset.derived.mezzanine)
  if (!asset.browserDecodable) urls.push(originalUrl(asset))
  if (asset.derived.proxy) urls.push(asset.derived.proxy)
  return [...new Set(urls)]
}
