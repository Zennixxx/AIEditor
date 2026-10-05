// ID по CONTRACT §1: префикс + nanoid(10).
const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'

export type IdPrefix = 'trk' | 'clp' | 'mrk' | 'fx' | 'sec' | 'job' | 'prj' | 'pst' | 'tmp' | 'x'

export function newId(prefix: IdPrefix, size = 10): string {
  const bytes = crypto.getRandomValues(new Uint8Array(size))
  let id = ''
  for (const b of bytes) id += ALPHABET[b % ALPHABET.length]
  return `${prefix}_${id}`
}

export function isTempId(id: string): boolean {
  return id.startsWith('tmp_')
}
