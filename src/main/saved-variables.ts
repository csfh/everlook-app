/**
 * Reads the top level of an Everlook SavedVariables file without a Lua parser.
 *
 * The file holds the whole collection (`raw`), settings for other addons and
 * the signed upload: the segments, their manifest, and the signer and
 * signature. Only the upload is sent. A key counts only where its table sits,
 * so a name inside the collected rows is not the file's. Strings are skipped
 * whole, so a brace in a quest text does not move the depth.
 *
 * The text is read as latin1 so every byte is one character. Offsets then
 * match the file, and a value copied out is byte for byte what was written.
 */

/** What the site reads, in the order it is written. */
const UPLOADED_KEYS = ['segments', 'manifest', 'signer', 'signature', 'world'] as const

export const NO_WORLD_DATA_CODE = 'ENODATA'

export function noWorldDataError(): Error {
  return Object.assign(new Error('Everlook.lua has no collected data to upload yet.'), { code: NO_WORLD_DATA_CODE })
}

class Unreadable extends Error {}

const STRING_EDGE = /["\\]/g
const TABLE_EDGE = /["{}]/g
const BARE_END = /[,}\r\n]/g

function skipString(text: string, quote: number): number {
  STRING_EDGE.lastIndex = quote + 1
  for (;;) {
    const hit = STRING_EDGE.exec(text)
    if (hit === null) throw new Unreadable('string is not closed')
    if (hit[0] === '"') return hit.index + 1
    STRING_EDGE.lastIndex = hit.index + 2
  }
}

function skipTable(text: string, open: number): number {
  let depth = 0
  TABLE_EDGE.lastIndex = open
  for (;;) {
    const hit = TABLE_EDGE.exec(text)
    if (hit === null) throw new Unreadable('table is not closed')
    if (hit[0] === '"') {
      TABLE_EDGE.lastIndex = skipString(text, hit.index)
      continue
    }
    depth += hit[0] === '{' ? 1 : -1
    if (depth === 0) return hit.index + 1
  }
}

function skipValue(text: string, start: number): number {
  const first = text[start]
  if (first === '"') return skipString(text, start)
  if (first === '{') return skipTable(text, start)
  BARE_END.lastIndex = start
  const hit = BARE_END.exec(text)
  return hit === null ? text.length : Math.max(hit.index, start + 1)
}

function skipSpace(text: string, from: number, extra = ''): number {
  let at = from
  while (at < text.length) {
    const character = text.charAt(at)
    if (!' \t\r\n'.includes(character) && !extra.includes(character)) break
    at += 1
  }
  return at
}

/** The entries of the table that opens at `open`, as the text span of each value, by key. */
function children(text: string, open: number): Map<string, [number, number]> {
  const found = new Map<string, [number, number]>()
  let at = open + 1
  for (;;) {
    at = skipSpace(text, at, ',;')
    if (at >= text.length) throw new Unreadable('table is not closed')
    if (text[at] === '}') return found
    if (text[at] !== '[') {
      at = skipValue(text, at)
      continue
    }
    let key: string
    at += 1
    if (text[at] === '"') {
      const end = skipString(text, at)
      key = text.slice(at + 1, end - 1)
      at = end
    } else {
      const end = text.indexOf(']', at)
      if (end === -1) throw new Unreadable('key is not closed')
      key = text.slice(at, end).trim()
      at = end
    }
    at = skipSpace(text, at)
    if (text[at] !== ']') throw new Unreadable('key is not closed')
    at = skipSpace(text, at + 1)
    if (text[at] !== '=') throw new Unreadable('key has no value')
    at = skipSpace(text, at + 1)
    const end = skipValue(text, at)
    if (!found.has(key)) found.set(key, [at, end])
    at = end
  }
}

/**
 * The part of the file that is uploaded: the segments, the manifest, the
 * signer and signature, and a whole world an older addon left. Nothing else
 * leaves the machine. Null when the file holds no data to send, or cannot be
 * followed, so the whole file is never sent in its place.
 */
export function uploadableWorld(contents: Buffer): Buffer | null {
  const text = contents.toString('latin1')
  const start = /\bEverlookDB\s*=\s*\{/.exec(text)
  if (start === null) return null

  let top: Map<string, [number, number]>
  try {
    top = children(text, start.index + start[0].length - 1)
  } catch (error) {
    if (error instanceof Unreadable) return null
    throw error
  }

  if (!top.has('manifest') && !top.has('world')) return null

  const parts = ['EverlookDB = {\r\n']
  for (const key of UPLOADED_KEYS) {
    const span = top.get(key)
    if (span === undefined) continue
    parts.push(`["${key}"] = `, text.slice(span[0], span[1]), ',\r\n')
  }
  parts.push('}\r\n')
  return Buffer.from(parts.join(''), 'latin1')
}
