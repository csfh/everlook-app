import type { Dirent } from 'node:fs'
import { access, readdir, readFile, realpath, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export const FOREVER_FLAVOR_DIRECTORIES = ['_classic_beta_', '_forever_'] as const

export const FOREVER_PRODUCTS = ['wow_classic_beta'] as const

async function exists(candidate: string): Promise<boolean> {
  try {
    await access(candidate)
    return true
  } catch {
    return false
  }
}

async function accountWorldFiles(wowRoot: string): Promise<string[]> {
  const accountRoot = path.join(wowRoot, 'WTF', 'Account')
  if (!(await exists(accountRoot))) return []

  const entries = await readdir(accountRoot, { withFileTypes: true })
  const accounts: Dirent[] = []
  for (const entry of entries) {
    // Dirent.isDirectory() is false for a symlink. Account folders are often linked.
    if (await isDirectoryEntry(accountRoot, entry)) accounts.push(entry)
  }
  const found = new Map<string, string>()
  for (const entry of accounts) {
    const candidate = path.join(accountRoot, entry.name, 'SavedVariables', 'Everlook.lua')
    if (!(await exists(candidate))) continue
    // Keep the path under WTF so the account name and flavor folder survive a symlink.
    let canonical = candidate
    try {
      canonical = await realpath(candidate)
    } catch {
      // Dedupe on the path we will store.
    }
    if (!found.has(canonical)) found.set(canonical, candidate)
  }
  return [...found.values()]
}

export function parseSteamLibraryFolders(contents: string): string[] {
  const paths: string[] = []
  const matches = contents.matchAll(/"path"\s+"([^"]+)"/g)
  for (const match of matches) {
    const raw = match[1]
    if (!raw) continue
    paths.push(raw.replaceAll('\\\\', '\\'))
  }
  return [...new Set(paths)]
}

export function buildInfoHasForeverProduct(contents: string): boolean {
  return FOREVER_PRODUCTS.some((product) => contents.includes(product))
}

export async function isForeverInstall(wowRoot: string): Promise<boolean> {
  const flavors = await Promise.all(
    FOREVER_FLAVOR_DIRECTORIES.map((flavor) => exists(path.join(wowRoot, flavor)))
  )
  if (flavors.some(Boolean)) return true

  try {
    const contents = await readFile(path.join(wowRoot, '.build.info'), 'utf8')
    return buildInfoHasForeverProduct(contents)
  } catch {
    return false
  }
}

async function isDirectoryEntry(parent: string, entry: Dirent): Promise<boolean> {
  if (entry.isDirectory()) return true
  if (!entry.isSymbolicLink()) return false
  try {
    return (await stat(path.join(parent, entry.name))).isDirectory()
  } catch {
    return false
  }
}

function steamInstallRoots(homeDirectory: string, platform: string): string[] {
  if (platform === 'win32') {
    return [
      process.env.PROGRAMFILES ? path.join(process.env.PROGRAMFILES, 'Steam') : null,
      process.env['PROGRAMFILES(X86)'] ? path.join(process.env['PROGRAMFILES(X86)'], 'Steam') : null,
      path.join(homeDirectory, 'Steam')
    ].filter((candidate): candidate is string => candidate !== null)
  }

  if (platform === 'darwin') {
    return [path.join(homeDirectory, 'Library', 'Application Support', 'Steam')]
  }

  const flatpak = path.join(homeDirectory, '.var', 'app', 'com.valvesoftware.Steam')
  return [
    path.join(homeDirectory, '.local', 'share', 'Steam'),
    path.join(homeDirectory, '.steam', 'steam'),
    path.join(homeDirectory, '.steam', 'root'),
    path.join(flatpak, 'data', 'Steam'),
    path.join(flatpak, '.local', 'share', 'Steam'),
    path.join(flatpak, '.steam', 'steam'),
    path.join(flatpak, '.steam', 'root')
  ]
}

async function steamLibraryRoots(homeDirectory: string, platform: string): Promise<string[]> {
  const libraries = new Set<string>()

  await Promise.all(steamInstallRoots(homeDirectory, platform).map(async (steamRoot) => {
    libraries.add(steamRoot)
    const manifest = path.join(steamRoot, 'steamapps', 'libraryfolders.vdf')
    if (!(await exists(manifest))) return
    try {
      for (const library of parseSteamLibraryFolders(await readFile(manifest, 'utf8'))) {
        libraries.add(library)
      }
    } catch {
      // Skip an unreadable library manifest and keep the default Steam root.
    }
  }))

  return [...libraries]
}

function wowRootsUnderSteamLibrary(library: string): string[] {
  return [
    path.join(library, 'steamapps', 'common', 'World of Warcraft'),
    path.join(library, 'steamapps', 'common', 'World of Warcraft Forever')
  ]
}

async function wowRootsUnderCompatData(library: string): Promise<string[]> {
  const compatData = path.join(library, 'steamapps', 'compatdata')
  if (!(await exists(compatData))) return []

  const prefixes = await readdir(compatData, { withFileTypes: true })
  const roots: string[] = []
  for (const prefix of prefixes) {
    if (!(await isDirectoryEntry(compatData, prefix))) continue
    for (const programFiles of ['Program Files (x86)', 'Program Files']) {
      roots.push(
        path.join(compatData, prefix.name, 'pfx', 'drive_c', programFiles, 'World of Warcraft')
      )
    }
  }
  return roots
}

export async function discoverFromRoot(selectedPath: string): Promise<string[]> {
  if (!(await exists(selectedPath))) return []
  const selectedStat = await stat(selectedPath)
  if (selectedStat.isFile()) {
    return path.basename(selectedPath).toLowerCase() === 'everlook.lua'
      ? [await realpath(selectedPath)]
      : []
  }

  const roots = [
    selectedPath,
    ...FOREVER_FLAVOR_DIRECTORIES.map((flavor) => path.join(selectedPath, flavor))
  ]
  const nested = await Promise.all(roots.map(accountWorldFiles))
  return [...new Set(nested.flat())].sort()
}

async function childDirectories(directory: string): Promise<string[]> {
  if (!(await exists(directory))) return []
  const entries = await readdir(directory, { withFileTypes: true })
  const children: string[] = []
  for (const entry of entries) {
    if (await isDirectoryEntry(directory, entry)) children.push(path.join(directory, entry.name))
  }
  return children
}

async function wowRootsUnderWinePrefixes(homeDirectory: string): Promise<string[]> {
  const roots: string[] = []
  const prefixParents = [
    path.join(homeDirectory, 'Games'),
    path.join(homeDirectory, 'Games', 'Heroic', 'Prefixes'),
    path.join(homeDirectory, '.local', 'share', 'bottles', 'bottles'),
    path.join(homeDirectory, '.var', 'app', 'com.usebottles.bottles', 'data', 'bottles', 'bottles'),
    path.join(homeDirectory, '.var', 'app', 'com.heroicgameslauncher.hgl', 'config', 'heroic', 'Prefixes')
  ]
  const prefixes = [
    path.join(homeDirectory, '.wine'),
    ...(await Promise.all(prefixParents.map(childDirectories))).flat()
  ]

  for (const prefix of prefixes) {
    for (const programFiles of ['Program Files (x86)', 'Program Files']) {
      roots.push(path.join(prefix, 'drive_c', programFiles, 'World of Warcraft'))
      roots.push(path.join(prefix, 'pfx', 'drive_c', programFiles, 'World of Warcraft'))
    }
  }
  return roots
}

export async function commonWowRoots(
  homeDirectory = os.homedir(),
  platform = process.platform
): Promise<string[]> {
  const candidates = new Set<string>()

  if (platform === 'win32') {
    for (const base of [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)']]) {
      if (base) candidates.add(path.join(base, 'World of Warcraft'))
    }
  } else if (platform === 'darwin') {
    candidates.add('/Applications/World of Warcraft')
    candidates.add(path.join(homeDirectory, 'Applications', 'World of Warcraft'))
  }

  const libraries = await steamLibraryRoots(homeDirectory, platform)
  await Promise.all(libraries.map(async (library) => {
    for (const root of wowRootsUnderSteamLibrary(library)) {
      candidates.add(root)
    }
    for (const root of await wowRootsUnderCompatData(library)) {
      candidates.add(root)
    }
  }))

  if (platform === 'linux') {
    for (const root of await wowRootsUnderWinePrefixes(homeDirectory)) {
      candidates.add(root)
    }
  }

  const resolved = await mapLimited([...candidates], 32, async (candidate) => {
    if (!(await exists(candidate)) || !(await isForeverInstall(candidate))) return null
    // Steam's ~/.steam/steam and ~/.steam/root are symlinks to the same library.
    // access() follows them, so each spelling would otherwise look like another install.
    try {
      return await realpath(candidate)
    } catch {
      return candidate
    }
  })

  return [...new Set(resolved.filter((candidate): candidate is string => candidate !== null))].sort()
}

/** Bounds filesystem probes so a large Steam library does not stall startup one prefix at a time. */
async function mapLimited<T, R>(items: readonly T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let cursor = 0
  const run = async (): Promise<void> => {
    while (cursor < items.length) {
      const index = cursor
      cursor += 1
      const item = items[index]
      if (item === undefined) return
      results[index] = await worker(item)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => run()))
  return results
}

export async function discoverWorldFiles(
  homeDirectory = os.homedir(),
  platform = process.platform
): Promise<string[]> {
  const roots = await commonWowRoots(homeDirectory, platform)
  const files = await Promise.all(roots.map(discoverFromRoot))
  return [...new Set(files.flat())].sort()
}

export function accountName(worldFilePath: string): string {
  const parts = worldFilePath.split(/[\\/]/)
  const accountIndex = parts.lastIndexOf('Account')
  const account = accountIndex >= 0 ? parts[accountIndex + 1] : undefined
  return account ? account : 'Unknown account'
}
