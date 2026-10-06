interface SaveFileType {
  description: string
  accept: Record<string, string[]>
}

type SavePicker = (options: {
  suggestedName?: string
  types?: SaveFileType[]
}) => Promise<FileSystemFileHandle>

export function savePicker(): SavePicker | null {
  const picker = (window as unknown as { showSaveFilePicker?: SavePicker }).showSaveFilePicker
  return typeof picker === 'function' ? picker.bind(window) : null
}

export function isAbort(e: unknown): boolean {
  return e instanceof DOMException && e.name === 'AbortError'
}

export async function pickFile(
  name: string,
  type: SaveFileType,
): Promise<FileSystemFileHandle | 'canceled' | null> {
  const picker = savePicker()
  if (!picker) return null
  try {
    return await picker({ suggestedName: name, types: [type] })
  } catch (e) {
    if (isAbort(e)) return 'canceled'
    throw e
  }
}

export function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.style.display = 'none'
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

export async function saveBlob(
  blob: Blob,
  name: string,
  type: SaveFileType,
): Promise<'saved' | 'downloaded' | 'canceled'> {
  const handle = await pickFile(name, type)
  if (handle === 'canceled') return 'canceled'
  if (!handle) {
    downloadBlob(blob, name)
    return 'downloaded'
  }
  const writable = await handle.createWritable()
  await writable.write(blob)
  await writable.close()
  return 'saved'
}

export const MP4_TYPE: SaveFileType = { description: 'Видео MP4', accept: { 'video/mp4': ['.mp4'] } }
export const JSX_TYPE: SaveFileType = {
  description: 'Скрипт After Effects',
  accept: { 'text/javascript': ['.jsx'] },
}
