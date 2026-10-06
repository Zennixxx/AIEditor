import type { AssetLookup } from '@/playback/timing'
import type { Asset, Clip } from '@/shared/types.gen'

export function originalUrl(asset: Pick<Asset, 'id'>): string {
  return `/api/assets/${asset.id}/original`
}

export function videoCandidates(
  clip: Pick<Clip, 'interpolatedAssetId'>,
  asset: Asset,
  lookup: AssetLookup,
): string[] {
  const urls: string[] = []
  const interpolated = clip.interpolatedAssetId ? lookup(clip.interpolatedAssetId) : undefined
  if (interpolated && interpolated.status === 'ready') urls.push(originalUrl(interpolated))
  if (asset.browserDecodable) urls.push(originalUrl(asset))
  if (asset.derived.mezzanine) urls.push(asset.derived.mezzanine)
  if (!asset.browserDecodable) urls.push(originalUrl(asset))
  if (asset.derived.proxy) urls.push(asset.derived.proxy)
  return [...new Set(urls)]
}
