import { readdirSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'

const WINDOWS_SHORT_NAME = /~[0-9]/

function unwrapQuotedWindowsPath(filePath: string): string {
  if (filePath.length >= 2 && filePath.startsWith('"') && filePath.endsWith('"')) {
    return filePath.slice(1, -1)
  }
  return filePath
}

function stripWindowsNamespace(filePath: string): string {
  if (filePath.startsWith('\\\\?\\UNC\\')) return `\\${filePath.slice(7)}`
  if (filePath.startsWith('\\\\?\\')) return filePath.slice(4)
  return filePath
}

function followRealPath(filePath: string): string {
  let nativePath: string | null = null
  let jsPath: string | null = null
  try {
    nativePath = stripWindowsNamespace(realpathSync.native(filePath))
  } catch {
    // The file may be gone, or Windows may refuse the handle.
  }
  try {
    jsPath = stripWindowsNamespace(realpathSync(filePath))
  } catch {
    // Same.
  }
  if (process.platform === 'win32') {
    const preferred = [nativePath, jsPath].find(
      (candidate): candidate is string => candidate !== null && !WINDOWS_SHORT_NAME.test(candidate)
    )
    if (preferred) return preferred
  }
  return nativePath ?? jsPath ?? filePath
}

/**
 * `realpath` on Windows can leave an 8.3 alias such as `C:\\Users\\RUNNER~1`.
 * Walk the existing prefix so that spelling and the long name share a key.
 */
function expandWindowsShortNames(filePath: string): string {
  if (process.platform !== 'win32' || !WINDOWS_SHORT_NAME.test(filePath)) return filePath

  const root = path.parse(filePath).root
  const segments = filePath.slice(root.length).split(/[\\/]/).filter(Boolean)
  let current = root
  for (const segment of segments) {
    const next = path.join(current, segment)
    if (!WINDOWS_SHORT_NAME.test(segment)) {
      current = next
      continue
    }

    let expanded = segment
    try {
      const wanted = statSync(next)
      const entries = readdirSync(current)
      const match = entries.find((entry) => {
        if (WINDOWS_SHORT_NAME.test(entry) && entry.toLowerCase() === segment.toLowerCase()) return false
        try {
          const candidate = statSync(path.join(current, entry))
          return wanted.ino !== 0 && candidate.dev === wanted.dev && candidate.ino === wanted.ino
        } catch {
          return false
        }
      })
      if (match) expanded = match
    } catch {
      // Keep the spelling we were given when this segment is gone.
    }
    current = path.join(current, expanded)
  }
  return current
}

/**
 * One identity for a world file path.
 * A symlink and its target are the same file. Windows paths also differ by letter case
 * and by 8.3 short names (`C:\\Users\\RUNNER~1` vs `C:\\Users\\runneradmin`).
 */
export function worldFileKey(filePath: string): string {
  const resolved = path.resolve(unwrapQuotedWindowsPath(filePath))
  const canonical = expandWindowsShortNames(followRealPath(resolved))
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical
}

export function canonicalSelectedWorldFile(filePath: string, selected: readonly string[]): string | null {
  const key = worldFileKey(filePath)
  return selected.find((candidate) => worldFileKey(candidate) === key) ?? null
}

/**
 * World files discovery may add.
 * A file the user stopped watching stays out, and so does one already selected.
 */
export function additionsToWatch(
  discovered: readonly string[],
  selected: readonly string[],
  ignored: readonly string[]
): string[] {
  const selectedKeys = new Set(selected.map(worldFileKey))
  const ignoredKeys = new Set(ignored.map(worldFileKey))
  const seen = new Set<string>()
  const additions: string[] = []
  for (const file of discovered) {
    const key = worldFileKey(file)
    if (selectedKeys.has(key) || ignoredKeys.has(key) || seen.has(key)) continue
    seen.add(key)
    additions.push(file)
  }
  return additions
}

export function watchFiles(
  selected: readonly string[],
  ignored: readonly string[],
  files: readonly string[]
): { selectedFiles: string[]; ignoredFiles: string[] } {
  const added = new Set(files.map(worldFileKey))
  return {
    selectedFiles: [...new Set([...selected, ...files])].sort(),
    ignoredFiles: ignored.filter((candidate) => !added.has(worldFileKey(candidate)))
  }
}

export function stopWatching(
  selected: readonly string[],
  ignored: readonly string[],
  filePath: string
): { selectedFiles: string[]; ignoredFiles: string[] } {
  const key = worldFileKey(filePath)
  return {
    selectedFiles: selected.filter((candidate) => worldFileKey(candidate) !== key),
    ignoredFiles: [...ignored.filter((candidate) => worldFileKey(candidate) !== key), filePath]
  }
}
