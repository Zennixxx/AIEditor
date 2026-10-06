export interface LastExport {
  blob: Blob | null
  bytes: number
  frames: number
  codec: string
  audio: string | null
  sources: Record<string, string>
}

let last: LastExport | null = null

export function setLastExport(value: LastExport): void {
  last = value
}

export function lastExport(): LastExport | null {
  return last
}
