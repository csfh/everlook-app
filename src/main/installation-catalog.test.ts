import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import type { InstallationState, SigningState } from '../shared/types'
import { loadInstallationCatalog, resolveAddonDirectory, retainInstallStatus } from './installation-catalog'
import { fingerprintOf, renderSignLua, signerOf } from './signing-token'

const execFileAsync = promisify(execFile)
const temporaryDirectories: string[] = []
const secret = 'catalog-token'
const signer = signerOf(secret)

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function makeTemp(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'everlook-catalog-'))
  temporaryDirectories.push(directory)
  return directory
}

function worldFile(root: string, flavor: string): string {
  return path.join(root, flavor, 'WTF', 'Account', 'Alice', 'SavedVariables', 'Everlook.lua')
}

async function writeSigner(file: string, value: string | null): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, value === null ? 'EverlookDB = {}\n' : `EverlookDB = {\n["signer"] = "${value}"\n}\n`)
}

async function writeAddon(addonsDirectory: string, version = '0.4.0'): Promise<void> {
  const addon = path.join(addonsDirectory, 'Everlook')
  await mkdir(addon, { recursive: true })
  await writeFile(path.join(addon, 'Everlook.toc'), `## Title: Everlook\n## Version: ${version}\n## Interface: 16001\n`)
  await writeFile(path.join(addon, 'world.lua'), 'local _, Everlook = ...\n')
  await writeFile(path.join(addon, 'sign.lua'), renderSignLua(secret))
}

function publishedFetch(version: string): typeof fetch {
  return async () => new Response(JSON.stringify({ title: 'Everlook', version, interface: '16001', available: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  })
}

describe('loadInstallationCatalog', () => {
  it('reports a missing addon when nothing is installed and still keeps the published version', async () => {
    const catalog = await loadInstallationCatalog({
      selectedFiles: [],
      roots: [],
      baseUrl: 'https://everlook.ing',
      accountSigner: null,
      fetch: publishedFetch('1.2.3')
    })

    expect(catalog.installations).toEqual([])
    expect(catalog.addon).toEqual({
      status: 'missing',
      addonsPath: null,
      version: null,
      publishedVersion: '1.2.3',
      title: null,
      interface: null,
      error: null
    })
    expect(catalog.signing.status).toBe('not_placed')
  })

  it('keeps the installed addon when the version check fails', async () => {
    const root = await makeTemp()
    const file = worldFile(root, '_forever_')
    await writeSigner(file, signer)
    await writeAddon(path.join(root, '_forever_', 'Interface', 'AddOns'))

    const catalog = await loadInstallationCatalog({
      selectedFiles: [file],
      roots: [],
      baseUrl: 'https://everlook.ing',
      accountSigner: signer,
      fetch: async () => { throw new Error('offline') }
    })

    expect(catalog.installations).toHaveLength(1)
    expect(catalog.addon).toMatchObject({ status: 'behind', version: '0.4.0', publishedVersion: null, title: 'Everlook' })
    expect(catalog.installations[0]?.signing.status).toBe('verified')
    expect(catalog.signing).toMatchObject({ status: 'verified', fingerprint: fingerprintOf(secret, true) })
  })

  it('uses an install’s own world files for its row and every selected file for the account', async () => {
    const root = await makeTemp()
    const matched = worldFile(root, '_forever_')
    const loose = path.join(root, 'loose', 'Everlook.lua')
    await writeSigner(matched, null)
    await writeSigner(loose, signer)
    await writeAddon(path.join(root, '_forever_', 'Interface', 'AddOns'))

    const catalog = await loadInstallationCatalog({
      selectedFiles: [matched, loose],
      roots: [root],
      baseUrl: 'https://everlook.ing',
      accountSigner: signer,
      fetch: publishedFetch('0.4.0')
    })

    expect(catalog.installations).toHaveLength(1)
    expect(catalog.installations[0]?.files).toEqual([matched])
    expect(catalog.installations[0]?.signing.status).toBe('placed')
    expect(catalog.addon.status).toBe('current')
    expect(catalog.signing.status).toBe('verified')
  })

  it('summarizes the first discovered install and leaves absent ones out of account signing', async () => {
    const root = await makeTemp()
    await mkdir(path.join(root, '_classic_beta_'), { recursive: true })
    const file = worldFile(root, '_forever_')
    await writeSigner(file, signer)
    await writeAddon(path.join(root, '_forever_', 'Interface', 'AddOns'), '0.1.0')

    const catalog = await loadInstallationCatalog({
      selectedFiles: [file],
      roots: [root],
      baseUrl: 'https://everlook.ing',
      accountSigner: signer,
      fetch: publishedFetch('0.4.0')
    })

    expect(catalog.installations.map((installation) => installation.addonsPath)).toEqual([
      path.join(root, '_classic_beta_', 'Interface', 'AddOns'),
      path.join(root, '_forever_', 'Interface', 'AddOns')
    ])
    expect(catalog.addon).toMatchObject({
      status: 'missing',
      addonsPath: path.join(root, '_classic_beta_', 'Interface', 'AddOns'),
      publishedVersion: '0.4.0'
    })
    expect(catalog.installations[0]?.signing.status).toBe('not_placed')
    expect(catalog.installations[1]?.status).toBe('behind')
    expect(catalog.installations[1]?.signing.status).toBe('verified')
    expect(catalog.signing.status).toBe('verified')
  })

  it('skips a development checkout instead of calling it unsigned', async () => {
    const root = await makeTemp()
    const addons = path.join(root, '_forever_', 'Interface', 'AddOns')
    const addon = path.join(root, 'repo', 'Everlook')
    await mkdir(addon, { recursive: true })
    await mkdir(addons, { recursive: true })
    await execFileAsync('git', ['init', '--quiet', path.join(root, 'repo')])
    await writeFile(path.join(addon, 'Everlook.toc'), '## Title: Everlook\n## Version: 0.4.0\n## Interface: 16001\n')
    await writeFile(path.join(addon, 'world.lua'), 'local _, Everlook = ...\n')
    await symlink(addon, path.join(addons, 'Everlook'), process.platform === 'win32' ? 'junction' : 'dir')

    const catalog = await loadInstallationCatalog({
      selectedFiles: [],
      roots: [root],
      baseUrl: 'https://everlook.ing',
      accountSigner: null,
      fetch: publishedFetch('0.4.0')
    })

    expect(catalog.installations).toHaveLength(1)
    expect(catalog.installations[0]?.status).toBe('git')
    expect(catalog.installations[0]?.signing.status).toBe('skipped')
    expect(catalog.signing.status).toBe('skipped')
  })
})

function installation(overrides: Partial<InstallationState> = {}): InstallationState {
  const addonsPath = overrides.addonsPath === undefined ? '/wow/_forever_/Interface/AddOns' : overrides.addonsPath
  return {
    status: 'current',
    addonsPath,
    version: '0.4.0',
    publishedVersion: '0.4.0',
    title: 'Everlook',
    interface: '16001',
    error: null,
    files: ['/wow/_forever_/WTF/Account/Alice/SavedVariables/Everlook.lua'],
    signing: { status: 'placed', fingerprint: 'oldoldol', placedPath: addonsPath, error: null },
    ...overrides
  }
}

const verified: SigningState = { status: 'verified', fingerprint: 'newnewne', placedPath: '/wow/_forever_/Interface/AddOns', error: null }

describe('retainInstallStatus', () => {
  it('keeps install status when a failed version check reports the addon as behind', () => {
    const current = installation()
    const demoted = installation({
      status: 'behind',
      publishedVersion: null,
      title: 'Everlook nightly',
      interface: '16002',
      error: 'offline',
      files: ['/wow/_forever_/WTF/Account/Alice/SavedVariables/Everlook.lua', '/wow/loose/Everlook.lua'],
      signing: verified
    })

    expect(retainInstallStatus([current], { installations: [demoted], signing: verified })).toEqual({
      signing: verified,
      installations: [{
        ...current,
        files: demoted.files,
        signing: verified
      }]
    })
  })

  it('leaves an install that was not reread, and does not add one that was not already shown', () => {
    const kept = installation({ addonsPath: '/wow/_classic_beta_/Interface/AddOns', status: 'missing' })
    const untouched = installation({ addonsPath: null, status: 'idle', files: [], signing: { status: 'unknown', fingerprint: null, placedPath: null, error: null } })
    const appeared = installation({ addonsPath: '/wow/_forever_/Interface/AddOns', status: 'behind' })

    expect(retainInstallStatus([kept, untouched], { installations: [appeared], signing: verified })).toEqual({
      signing: verified,
      installations: [kept, untouched]
    })
  })
})

describe('resolveAddonDirectory', () => {
  const forever = '/wow/_forever_/Interface/AddOns'
  const classic = '/wow/_classic_beta_/Interface/AddOns'

  it('uses the named install when it is one of the configured directories', () => {
    expect(resolveAddonDirectory([forever, classic], classic)).toBe(classic)
  })

  it('uses the only configured install when the action does not name one', () => {
    expect(resolveAddonDirectory([forever])).toBe(forever)
  })

  it('refuses an unknown install and a choice among several', () => {
    expect(() => resolveAddonDirectory([forever], '/wow/other/Interface/AddOns')).toThrow('This installation is not configured.')
    expect(() => resolveAddonDirectory([forever, classic])).toThrow('Choose an installation to update.')
    expect(() => resolveAddonDirectory([])).toThrow('Choose an installation to update.')
  })
})
