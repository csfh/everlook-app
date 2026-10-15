import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { inspectInstalledAddon } from './addon-install'

/**
 * Keeps the shared catalog the addon reads (`Everlook_Data`) current between addon releases. The site lists the
 * files of the pack with a digest each; this downloads the ones that changed, checks them, and writes them beside
 * the addon's own `data.lua`. See docs/contracts.md, "Data pack".
 */

export const DATA_PACK_MANIFEST_PATH = '/download/data-pack.json'
const DATA_FOLDER = 'Everlook_Data'
const FILE_NAME = /^[A-Za-z0-9_]+\.(?:lua|toc)$/
const VERSION = /^[0-9a-f]{12}$/
const MAX_FILES = 64
const MAX_BYTES = 1_572_864

type PackFile = { name: string; sha256: string; bytes: number }
type PackManifest = { version: string; files: PackFile[] }

export type DataPackResult = 'updated' | 'current' | 'skipped'

function parseManifest(value: unknown): PackManifest {
  const manifest = value as { version?: unknown; files?: unknown } | null
  if (manifest === null || typeof manifest !== 'object' || typeof manifest.version !== 'string' || !VERSION.test(manifest.version)) {
    throw new Error('The data pack manifest has no version.')
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0 || manifest.files.length > MAX_FILES) {
    throw new Error('The data pack manifest lists no files, or too many.')
  }
  let total = 0
  const names = new Set<string>()
  const files = manifest.files.map((entry: unknown): PackFile => {
    const file = entry as { name?: unknown; sha256?: unknown; bytes?: unknown }
    if (typeof file.name !== 'string' || !FILE_NAME.test(file.name) || file.name === 'data.lua' || names.has(file.name)) {
      throw new Error('The data pack manifest names a file that is not allowed.')
    }
    if (typeof file.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(file.sha256) || typeof file.bytes !== 'number' || !Number.isInteger(file.bytes) || file.bytes < 0) {
      throw new Error(`The data pack manifest is malformed for ${file.name}.`)
    }
    names.add(file.name)
    total += file.bytes
    return { name: file.name, sha256: file.sha256, bytes: file.bytes }
  })
  if (total > MAX_BYTES) throw new Error('The data pack is larger than the app will install.')
  if (!names.has('meta.lua') || !names.has('Everlook_Data.toc')) throw new Error('The data pack is missing its meta or its table of contents.')
  return { version: manifest.version, files }
}

async function installedVersion(directory: string): Promise<string | null> {
  try {
    const meta = await readFile(path.join(directory, 'meta.lua'), 'utf8')
    return /version = "([0-9a-f]{12})"/.exec(meta)?.[1] ?? null
  } catch {
    return null
  }
}

async function folderState(directory: string): Promise<'missing' | 'folder' | 'protected'> {
  try {
    const stats = await lstat(directory)
    return stats.isSymbolicLink() || !stats.isDirectory() ? 'protected' : 'folder'
  } catch {
    return 'missing'
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await lstat(file)
    return true
  } catch {
    return false
  }
}

/**
 * Brings one installation's pack up to date. It leaves a development checkout, a data folder that is a link, and an
 * installation without the addon's own `data.lua` alone, and it changes nothing unless every file checks out.
 */
export async function updateDataPack(options: {
  baseUrl: string
  addonsDirectory: string
  fetchImpl?: typeof fetch
}): Promise<DataPackResult> {
  const request = options.fetchImpl ?? fetch
  const base = options.baseUrl.replace(/\/$/, '')
  const installed = await inspectInstalledAddon(options.addonsDirectory)
  if (!installed.present || installed.symlink || installed.gitCheckout) return 'skipped'
  const directory = path.join(path.resolve(options.addonsDirectory), DATA_FOLDER)
  if ((await folderState(directory)) !== 'folder' || !(await exists(path.join(directory, 'data.lua')))) return 'skipped'

  const response = await request(`${base}${DATA_PACK_MANIFEST_PATH}`, { headers: { Accept: 'application/json' } })
  if (!response.ok) throw new Error(`The data pack manifest answered ${response.status}.`)
  const manifest = parseManifest(await response.json())

  const present = await Promise.all(manifest.files.map((file) => exists(path.join(directory, file.name))))
  if ((await installedVersion(directory)) === manifest.version && present.every(Boolean)) return 'current'

  // Every file is fetched and checked before anything is written.
  const contents = new Map<string, string>()
  for (const file of manifest.files) {
    const answer = await request(`${base}/download/data-pack/${file.name}`)
    if (!answer.ok) throw new Error(`The data pack file ${file.name} answered ${answer.status}.`)
    const text = await answer.text()
    if (Buffer.byteLength(text) !== file.bytes || createHash('sha256').update(text).digest('hex') !== file.sha256) {
      throw new Error(`The data pack file ${file.name} does not match its digest.`)
    }
    contents.set(file.name, text)
  }

  // The chunks and the table of contents first, the meta last: it carries the version, so an interrupted write is tried again.
  const order = [...manifest.files.map((file) => file.name).filter((name) => name !== 'meta.lua'), 'meta.lua']
  await mkdir(directory, { recursive: true })
  for (const name of order) {
    const temporary = path.join(directory, `.${name}.new`)
    await writeFile(temporary, contents.get(name) ?? '')
    await rename(temporary, path.join(directory, name))
  }
  // A chunk the pack no longer lists is old data.
  for (const entry of await readdir(directory)) {
    if (/^[a-z]+_\d+\.lua$/.test(entry) && !contents.has(entry)) await rm(path.join(directory, entry), { force: true })
  }
  return 'updated'
}
