import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AddonManager, type AddonManagerOptions } from './addon-manager'
import { renderSignLua, signerOf, signLuaPath } from './signing-token'

type Settings = ReturnType<AddonManagerOptions['settings']['get']>

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function makeTemp(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'everlook-manager-'))
  temporaryDirectories.push(directory)
  return directory
}

async function writeInstall(root: string, options: { addon?: boolean; secret?: string } = {}): Promise<{ file: string; addonsDirectory: string }> {
  const file = path.join(root, '_forever_', 'WTF', 'Account', 'Alice', 'SavedVariables', 'Everlook.lua')
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, 'EverlookDB = {}\n')
  const addonsDirectory = path.join(root, '_forever_', 'Interface', 'AddOns')
  await mkdir(addonsDirectory, { recursive: true })
  if (options.addon !== false) {
    const addon = path.join(addonsDirectory, 'Everlook')
    await mkdir(addon, { recursive: true })
    await writeFile(path.join(addon, 'Everlook.toc'), '## Title: Everlook\n## Version: 0.4.0\n## Interface: 16001\n')
    await writeFile(path.join(addon, 'world.lua'), 'local _, Everlook = ...\n')
    if (options.secret !== undefined) await writeFile(path.join(addon, 'sign.lua'), renderSignLua(options.secret))
  }
  return { file, addonsDirectory }
}

function publishedResponse(version = '1.2.3'): Response {
  return new Response(JSON.stringify({ title: 'Everlook', version, interface: '16001', available: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  })
}

function harness(input: {
  settings?: Partial<Settings>
  token?: string | null
  fetchImpl?: typeof fetch
  roots?: () => Promise<string[]>
} = {}) {
  let settings = { baseUrl: 'https://everlook.ing', autoWatch: true, selectedFiles: [], uploads: {}, installationRoots: [], ...input.settings } as Settings
  let published = 0
  const manager = new AddonManager({
    settings: {
      get: () => settings,
      update: async (update) => { settings = { ...settings, ...update }; return settings }
    },
    token: async () => input.token ?? null,
    signal: () => new AbortController().signal,
    userDataDirectory: () => os.tmpdir(),
    publish: async () => { published += 1 },
    roots: input.roots ?? (async () => []),
    fetchImpl: input.fetchImpl ?? (async () => publishedResponse())
  })
  return { manager, settings: () => settings, published: () => published }
}

describe('AddonManager', () => {
  it('reports a missing addon and publishes before and after the check', async () => {
    const { manager, published } = harness()

    await manager.refresh()

    expect(manager.addon).toMatchObject({ status: 'missing', publishedVersion: '1.2.3', error: null })
    expect(manager.installations).toEqual([])
    expect(manager.signing.status).toBe('not_placed')
    expect(published()).toBe(2)
  })

  it('reads an installation from a selected world file', async () => {
    const root = await makeTemp()
    const { file, addonsDirectory } = await writeInstall(root)
    const { manager } = harness({ settings: { selectedFiles: [file] } })

    await manager.refresh()

    expect(manager.installations).toHaveLength(1)
    expect(manager.installations[0]?.addonsPath).toBe(addonsDirectory)
    expect(manager.addon).toMatchObject({ status: 'behind', version: '0.4.0', publishedVersion: '1.2.3' })
  })

  it('records an error when the roots cannot be read and recovers on the next refresh', async () => {
    let fail = true
    const { manager } = harness({ roots: async () => { if (fail) throw new Error('boom'); return [] } })

    await manager.refresh()
    expect(manager.addon).toMatchObject({ status: 'error', error: 'boom' })

    fail = false
    await manager.refresh()
    expect(manager.addon).toMatchObject({ status: 'missing', error: null })
  })

  it('ignores a refresh that arrives while one is running', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    const { manager, published } = harness({ roots: async () => { await gate; return [] } })

    const first = manager.refresh()
    await manager.refresh()
    expect(published()).toBe(1)

    release()
    await first
    expect(published()).toBe(2)
    expect(manager.addon.status).toBe('missing')
  })

  it('places a token only for a signed-in account with the addon installed', async () => {
    const root = await makeTemp()
    const { file } = await writeInstall(root, { addon: false })

    await expect(harness({ settings: { selectedFiles: [file] } }).manager.placeSigningToken())
      .rejects.toThrow('Sign in to Everlook before placing a signing token.')
    await expect(harness({ settings: { selectedFiles: [file] }, token: 'token' }).manager.placeSigningToken())
      .rejects.toThrow('Install the Everlook addon before placing a signing token.')
  })

  it('writes the signing token, remembers the signer and reports the placement', async () => {
    const root = await makeTemp()
    const { file, addonsDirectory } = await writeInstall(root)
    const { manager, settings, published } = harness({
      settings: { selectedFiles: [file] },
      token: 'token',
      fetchImpl: async (input) => String(input).endsWith('/api/desktop/signing-secret')
        ? new Response(JSON.stringify({ secret: 'manager-secret' }), { status: 200, headers: { 'Content-Type': 'application/json' } })
        : publishedResponse()
    })

    const result = await manager.placeSigningToken()

    expect(result).toEqual({ placed: 1, skipped: 0 })
    expect(await readFile(signLuaPath(addonsDirectory), 'utf8')).toContain('manager-secret')
    expect(settings().accountSigner).toBe(signerOf('manager-secret'))
    expect(manager.signing.status).toBe('placed')
    expect(published()).toBe(1)
  })

  it('refuses to install over a development checkout and still refreshes afterwards', async () => {
    const root = await makeTemp()
    const checkout = await makeTemp()
    const { file, addonsDirectory } = await writeInstall(root, { addon: false })
    await writeFile(path.join(checkout, 'Everlook.toc'), '## Title: Everlook\n## Version: 0.4.0\n## Interface: 16001\n')
    await symlink(checkout, path.join(addonsDirectory, 'Everlook'), process.platform === 'win32' ? 'junction' : 'dir')
    const { manager, published } = harness({ settings: { selectedFiles: [file] } })

    await expect(manager.install()).rejects.toThrow('This installation is a protected development checkout.')

    expect(published()).toBe(3)
    expect(manager.installations).toHaveLength(1)
  })
})
