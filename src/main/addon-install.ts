import { execFile } from 'node:child_process'
import type { Stats } from 'node:fs'
import { access, cp, lstat, mkdir, readdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { FOREVER_FLAVOR_DIRECTORIES } from './discovery'

const execFileAsync = promisify(execFile)

export const DEFAULT_ADDON_DOWNLOAD_PATH = '/download/addon'

export function isPathInside(parent: string, child: string): boolean {
  const root = path.resolve(parent)
  const target = path.resolve(child)
  return target === root || target.startsWith(root + path.sep)
}

const CORE_ADDON_FOLDER = 'Everlook'
const MODULE_ADDON_FOLDER = /^Everlook_[A-Za-z0-9]+$/

/** The release ships the core folder and one `Everlook_<Name>` folder per module addon. */
export function isAddonFolderName(name: string): boolean {
  return name === CORE_ADDON_FOLDER || MODULE_ADDON_FOLDER.test(name)
}

export function isSafeAddonMember(member: string): boolean {
  const normalized = member.replaceAll('\\', '/').replace(/^\.\//, '')
  if (normalized === '' || normalized === '.') return true
  if (path.posix.isAbsolute(normalized) || /^[A-Za-z]:/.test(normalized)) return false
  const parts = normalized.split('/').filter((part) => part !== '')
  if (parts.length === 0) return true
  if (parts.some((part) => part === '..')) return false
  return isAddonFolderName(parts[0] ?? '')
}

export function assertSafeAddonArchive(members: string[]): void {
  if (members.length === 0) throw new Error('Everlook archive is empty.')
  for (const member of members) {
    if (!isSafeAddonMember(member)) {
      throw new Error(`Everlook archive contains an unsafe path: ${member}`)
    }
  }
  const hasToc = members.some((member) => {
    const normalized = member.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '')
    return normalized === 'Everlook/Everlook.toc'
  })
  if (!hasToc) throw new Error('Everlook archive is missing Everlook/Everlook.toc.')
}

export const ADDON_FLAVOR_DIRECTORIES = [...FOREVER_FLAVOR_DIRECTORIES]

function flavorDirectoryIndex(parts: string[]): number {
  // The flavor folder is the parent of WTF. An account named like `_main_` sits
  // further down the path and must not be treated as the game folder.
  const wtf = parts.findLastIndex((part) => part.toLowerCase() === 'wtf')
  if (wtf <= 0) return -1
  return /^_[a-z0-9]+(?:_[a-z0-9]+)*_$/i.test(parts[wtf - 1] ?? '') ? wtf - 1 : -1
}

export function addonsDirectoryFromWorldFile(worldFilePath: string): string | null {
  const resolved = path.resolve(worldFilePath)
  const parts = resolved.split(/[\\/]/)
  const flavorIndex = flavorDirectoryIndex(parts)
  if (flavorIndex < 0) return null
  return path.join(path.parse(resolved).root, ...parts.slice(1, flavorIndex + 1), 'Interface', 'AddOns')
}

export async function discoverAddonsDirectories(
  worldFilePaths: string[],
  wowRoots: string[]
): Promise<string[]> {
  const directories = new Set<string>()
  for (const worldFile of worldFilePaths) {
    const fromWorldFile = addonsDirectoryFromWorldFile(worldFile)
    if (fromWorldFile) directories.add(fromWorldFile)
  }
  for (const root of wowRoots) {
    for (const flavor of ADDON_FLAVOR_DIRECTORIES) {
      directories.add(path.join(root, flavor, 'Interface', 'AddOns'))
    }
  }
  const candidates = [...directories]
  const present = await Promise.all(
    candidates.map(async (directory) => {
      try {
        await access(path.dirname(path.dirname(directory)))
        return true
      } catch {
        return false
      }
    })
  )
  const found = new Map<string, string>()
  for (const [index, directory] of candidates.entries()) {
    if (!present[index]) continue
    const key = await canonicalAddonsDirectory(directory)
    if (!found.has(key)) found.set(key, directory)
  }
  return [...found.values()].sort()
}

/** One key for a flavor folder reached through different symlink spellings. */
async function canonicalAddonsDirectory(directory: string): Promise<string> {
  const flavor = path.dirname(path.dirname(directory))
  try {
    return path.join(await realpath(flavor), 'Interface', 'AddOns')
  } catch {
    return directory
  }
}

export function addonDownloadUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/$/, '')}${DEFAULT_ADDON_DOWNLOAD_PATH}`
}

export type TocMeta = {
  title: string | null
  version: string | null
  interface: string | null
}

export function parseToc(contents: string): TocMeta {
  return {
    title: tocField(contents, 'Title'),
    version: tocField(contents, 'Version'),
    interface: tocField(contents, 'Interface')
  }
}

export function versionFromToc(contents: string): string | null {
  return parseToc(contents).version
}

function tocField(contents: string, name: string): string | null {
  const match = contents.match(new RegExp(`^## ${name}:\\s*(.+)\\s*$`, 'm'))
  return match?.[1]?.trim() ?? null
}

export type InstalledAddon = {
  addonsDirectory: string
  present: boolean
  tocPath: string | null
  title: string | null
  version: string | null
  interface: string | null
  symlink: boolean
  gitCheckout: boolean
}

export async function inspectInstalledAddon(addonsDirectory: string): Promise<InstalledAddon> {
  const addons = path.resolve(addonsDirectory)
  const destination = path.join(addons, 'Everlook')
  const empty: InstalledAddon = {
    addonsDirectory: addons,
    present: false,
    tocPath: null,
    title: null,
    version: null,
    interface: null,
    symlink: false,
    gitCheckout: false
  }

  const existing = await existingAddonEntry(destination)
  if (existing === null) return empty

  const symlink = existing.isSymbolicLink()
  let gitCheckout = false
  try {
    const target = symlink ? await realpath(destination) : destination
    gitCheckout = await isGitCheckout(target)
  } catch {
    // Keep gitCheckout false when the AddOns path cannot be resolved.
  }

  const tocPath = path.join(destination, 'Everlook.toc')
  let toc: TocMeta
  try {
    toc = parseToc(await readFile(tocPath, 'utf8'))
  } catch {
    return { ...empty, symlink, gitCheckout, tocPath }
  }

  let hasLua = false
  try {
    await access(path.join(destination, 'world.lua'))
    hasLua = true
  } catch {
    // world.lua is the TOC wiring file. SavedVariables Everlook.lua lives in WTF.
  }

  const titled = (toc.title ?? '').toLowerCase() === 'everlook'
  const present = titled && toc.version !== null && hasLua

  return {
    addonsDirectory: addons,
    present,
    tocPath,
    title: toc.title,
    version: toc.version,
    interface: toc.interface,
    symlink,
    gitCheckout
  }
}

async function isGitCheckout(directory: string): Promise<boolean> {
  try {
    await access(path.join(directory, '.git'))
    return true
  } catch {
    return false
  }
}

export const DEFAULT_ADDON_MANIFEST_PATH = '/download/addon.json'

export function addonManifestUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/$/, '')}${DEFAULT_ADDON_MANIFEST_PATH}`
}

export type PublishedAddon = {
  version: string
  title: string | null
  interface: string | null
  available: boolean
}

export async function fetchPublishedAddon(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch
): Promise<PublishedAddon> {
  const response = await fetchImpl(addonManifestUrl(baseUrl), { redirect: 'follow' })
  if (!response.ok) {
    throw new Error(`Everlook version check failed (${response.status}).`)
  }
  const body: unknown = await response.json()
  if (typeof body !== 'object' || body === null) {
    throw new Error('Everlook version check returned an empty payload.')
  }
  const record = body as Record<string, unknown>
  const version = typeof record.version === 'string' ? record.version.trim() : ''
  if (version === '') {
    throw new Error('Everlook version check is missing a TOC version.')
  }
  return {
    version,
    title: typeof record.title === 'string' ? record.title : null,
    interface: typeof record.interface === 'string' ? record.interface : null,
    available: record.available === true
  }
}

export function compareAddonVersions(left: string, right: string): number {
  const a = left.split('.').map((part) => Number.parseInt(part, 10) || 0)
  const b = right.split('.').map((part) => Number.parseInt(part, 10) || 0)
  const length = Math.max(a.length, b.length)
  for (let index = 0; index < length; index += 1) {
    const delta = (a[index] ?? 0) - (b[index] ?? 0)
    if (delta < 0) return -1
    if (delta > 0) return 1
  }
  return 0
}

export type AddonProbeStatus = 'current' | 'behind' | 'missing' | 'git'

export function addonStatusFromProbe(
  installed: InstalledAddon,
  published: PublishedAddon | null
): AddonProbeStatus {
  if (installed.gitCheckout || installed.symlink) return 'git'
  if (!installed.present) return 'missing'
  if (published === null || installed.version === null) return 'behind'
  return compareAddonVersions(installed.version, published.version) >= 0 ? 'current' : 'behind'
}

export type AddonInstallResult = {
  addonsDirectory: string
  tocPath: string
  version: string | null
  title: string | null
  interface: string | null
  skipped: boolean
  gitCheckout: boolean
}

export async function installAddon(options: {
  downloadUrl: string
  addonsDirectory: string
  fetchImpl?: typeof fetch
  userDataDirectory: string
}): Promise<AddonInstallResult> {
  const addonsDirectory = path.resolve(options.addonsDirectory)
  await mkdir(addonsDirectory, { recursive: true })
  const addonsReal = await realpath(addonsDirectory)
  const destination = path.join(addonsReal, 'Everlook')
  if (!isPathInside(addonsReal, destination)) {
    throw new Error('Refusing to install Everlook outside Interface/AddOns.')
  }

  const installed = await inspectInstalledAddon(addonsReal)
  if (installed.symlink) {
    const reason = installed.gitCheckout
      ? `Skipping Everlook install because ${destination} is a git checkout.`
      : `Skipping Everlook install because ${destination} is a symlink.`
    console.warn(reason)
    return {
      addonsDirectory: addonsReal,
      tocPath: installed.tocPath ?? path.join(destination, 'Everlook.toc'),
      version: installed.version,
      title: installed.title,
      interface: installed.interface,
      skipped: true,
      gitCheckout: installed.gitCheckout
    }
  }

  const workRoot = path.join(options.userDataDirectory, 'addon-install')
  await mkdir(workRoot, { recursive: true })
  const archivePath = path.join(workRoot, 'Everlook-latest.tar.gz')
  const extractRoot = path.join(workRoot, `extract-${Date.now()}`)
  await mkdir(extractRoot, { recursive: true })

  try {
    await downloadToFile(options.downloadUrl, archivePath, options.fetchImpl ?? fetch)
    const members = await listTarMembers(archivePath)
    assertSafeAddonArchive(members)
    await runTar(workRoot, ['-xzf', path.basename(archivePath), '-C', path.basename(extractRoot)], 32 * 1024 * 1024)
    await assertExtractedTreeIsSafe(extractRoot)
    const tocPath = path.join(extractRoot, 'Everlook', 'Everlook.toc')
    await access(tocPath)
    const toc = parseToc(await readFile(tocPath, 'utf8'))
    const folders = await extractedAddonFolders(extractRoot)
    await carrySigningToken(destination, path.join(extractRoot, 'Everlook'))
    await replaceAddonFolders(addonsReal, extractRoot, folders)
    await removeDroppedModules(addonsReal, folders)
    const installedToc = path.join(destination, 'Everlook.toc')
    await access(installedToc)
    if (!isPathInside(addonsReal, await realpath(installedToc))) {
      throw new Error('Installed Everlook.toc is outside Interface/AddOns.')
    }
    return {
      addonsDirectory: addonsReal,
      tocPath: installedToc,
      version: toc.version,
      title: toc.title,
      interface: toc.interface,
      skipped: false,
      gitCheckout: false
    }
  } finally {
    await rm(extractRoot, { recursive: true, force: true })
    await rm(archivePath, { force: true })
  }
}

async function downloadToFile(
  url: string,
  destination: string,
  fetchImpl: typeof fetch
): Promise<void> {
  const response = await fetchImpl(url, { redirect: 'follow' })
  if (!response.ok) {
    throw new Error(`Everlook download failed (${response.status}).`)
  }
  await writeFile(destination, Buffer.from(await response.arrayBuffer()))
}

/**
 * Runs tar inside `directory` and names things relative to it. GNU tar, which Git for
 * Windows can put first on the PATH, reads the "C:" of an absolute Windows path as a host
 * name and fails, so no absolute path reaches it.
 */
function runTar(directory: string, args: string[], maxBuffer: number): Promise<{ stdout: string }> {
  return execFileAsync('tar', args, { cwd: directory, maxBuffer })
}

async function listTarMembers(archivePath: string): Promise<string[]> {
  const { stdout } = await runTar(path.dirname(archivePath), ['-tzf', path.basename(archivePath)], 10 * 1024 * 1024)
  return stdout.split(/\r?\n/).filter((line) => line.length > 0)
}

async function assertExtractedTreeIsSafe(root: string): Promise<void> {
  const rootReal = await realpath(root)
  const stack = [rootReal]
  while (stack.length > 0) {
    const current = stack.pop()
    if (!current) continue
    const entries = await readdir(current, { withFileTypes: true })
    for (const entry of entries) {
      const child = path.join(current, entry.name)
      if (entry.isSymbolicLink()) {
        throw new Error('Everlook archive contains a symlink.')
      }
      const childReal = await realpath(child)
      if (!isPathInside(rootReal, childReal)) {
        throw new Error('Everlook archive escaped the extract directory.')
      }
      if (entry.isDirectory()) stack.push(childReal)
    }
  }
}

async function existingAddonEntry(destination: string): Promise<Stats | null> {
  try {
    return await lstat(destination)
  } catch {
    return null
  }
}

async function extractedAddonFolders(extractRoot: string): Promise<string[]> {
  const entries = await readdir(extractRoot, { withFileTypes: true })
  return entries.filter((entry) => entry.isDirectory() && isAddonFolderName(entry.name)).map((entry) => entry.name)
}

type ReplacedFolder = { destination: string; backup: string | null }

/**
 * Swaps every extracted folder into AddOns. A failure part way puts back each folder
 * already replaced, so the game never loads a core from one release with modules from another.
 * A module folder that is a symlink is a development checkout and stays.
 */
async function replaceAddonFolders(addonsDirectory: string, extractRoot: string, folders: string[]): Promise<void> {
  const replaced: ReplacedFolder[] = []
  try {
    for (const name of folders) {
      const destination = path.join(addonsDirectory, name)
      const existing = await existingAddonEntry(destination)
      if (existing?.isSymbolicLink()) {
        console.warn(`Skipping ${name} because ${destination} is a symlink.`)
        continue
      }
      const backup = existing ? `${destination}.bak-${timestampForBackup()}` : null
      if (backup) await rename(destination, backup)
      replaced.push({ destination, backup })
      await moveIntoPlace(path.join(extractRoot, name), destination)
    }
  } catch (error) {
    for (const { destination, backup } of replaced.reverse()) {
      await rm(destination, { recursive: true, force: true })
      if (backup) await rename(backup, destination)
    }
    throw error
  }
  // A backup of the core folder would keep a plaintext copy of the signing token.
  for (const { backup } of replaced) {
    if (backup) await rm(backup, { recursive: true, force: true }).catch(() => undefined)
  }
  for (const name of folders) await removeStaleBackups(addonsDirectory, name)
}

// A module addon that a release no longer ships would otherwise keep loading.
async function removeDroppedModules(addonsDirectory: string, shipped: string[]): Promise<void> {
  for (const name of await readdir(addonsDirectory)) {
    if (!MODULE_ADDON_FOLDER.test(name) || shipped.includes(name)) continue
    const folder = path.join(addonsDirectory, name)
    const entry = await existingAddonEntry(folder)
    if (!entry?.isDirectory()) continue
    try {
      await rm(folder, { recursive: true, force: true })
    } catch (error) {
      console.warn(`Could not remove ${folder}, which this Everlook release no longer ships.`, error)
    }
  }
}

/**
 * `rename` stays on one filesystem. WoW often lives on another drive from the
 * app's user data, and that move fails with EXDEV until the tree is copied.
 */
async function moveIntoPlace(source: string, destination: string): Promise<void> {
  try {
    await rename(source, destination)
  } catch (error) {
    if (!hasCode(error, 'EXDEV')) throw error
    try {
      await cp(source, destination, { recursive: true })
    } catch (copyError) {
      await rm(destination, { recursive: true, force: true })
      throw copyError
    }
  }
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

async function carrySigningToken(destination: string, source: string): Promise<void> {
  let signLua: string
  try {
    signLua = await readFile(path.join(destination, 'sign.lua'), 'utf8')
  } catch {
    return
  }
  if (!signLua.includes('Everlook.config.token')) return
  await writeFile(path.join(source, 'sign.lua'), signLua, 'utf8')
}

// Earlier installs left Everlook.bak-<timestamp> folders behind, each holding sign.lua.
async function removeStaleBackups(addonsDirectory: string, name: string): Promise<void> {
  const pattern = new RegExp(`^${name}\\.bak-\\d{4}-`)
  try {
    for (const entry of await readdir(addonsDirectory)) {
      if (pattern.test(entry)) {
        await rm(path.join(addonsDirectory, entry), { recursive: true, force: true })
      }
    }
  } catch {
    // Cleanup is best effort. The install already succeeded.
  }
}

function timestampForBackup(): string {
  return new Date().toISOString().replaceAll(/[:.]/g, '-')
}
