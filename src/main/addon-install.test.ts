import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import {
  assertSafeAddonArchive,
  addonsDirectoryFromWorldFile,
  compareAddonVersions,
  discoverAddonsDirectories,
  fetchPublishedAddon,
  inspectInstalledAddon,
  installAddon,
  isPathInside,
  isSafeAddonMember,
  parseToc,
  addonDownloadUrl,
  addonManifestUrl,
  addonStatusFromProbe
} from './addon-install'

const execFileAsync = promisify(execFile)
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })))
})

async function makeTemp(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'everlook-addon-'))
  temporaryDirectories.push(directory)
  return directory
}

async function packFixture(root: string, extraMembers: string[] = [], modules: string[] = []): Promise<string> {
  const stage = path.join(root, 'stage')
  const addon = path.join(stage, 'Everlook')
  await mkdir(addon, { recursive: true })
  await writeFile(path.join(addon, 'Everlook.toc'), '## Interface: 120105\n## Version: 0.2.0\n')
  await writeFile(path.join(addon, 'world.lua'), 'local _, Everlook = ...\n')
  for (const name of modules) {
    await mkdir(path.join(stage, name), { recursive: true })
    await writeFile(path.join(stage, name, `${name}.toc`), '## Dependencies: Everlook\n## Version: 0.2.0\n')
  }
  const archive = path.join(root, 'Everlook-latest.tar.gz')
  await execFileAsync('tar', ['-czf', `../${path.basename(archive)}`, 'Everlook', ...modules, ...extraMembers], { cwd: stage })
  return archive
}

describe('Everlook extract path safety', () => {
  it('accepts only members under Everlook/ and its Everlook_<Name>/ module folders', () => {
    expect(isSafeAddonMember('Everlook/Everlook.toc')).toBe(true)
    expect(isSafeAddonMember('Everlook/core/db.lua')).toBe(true)
    expect(isSafeAddonMember('Everlook_SellJunk/Everlook_SellJunk.toc')).toBe(true)
    expect(isSafeAddonMember('Everlook_SmartIsland/assets/island_arrow.tga')).toBe(true)
    expect(isSafeAddonMember('Everlook_/x.lua')).toBe(false)
    expect(isSafeAddonMember('Everlook-Evil/x.lua')).toBe(false)
    expect(isSafeAddonMember('Everlook_Sell.Junk/x.lua')).toBe(false)
    expect(isSafeAddonMember('Everlook_SellJunk/../../WTF/x.lua')).toBe(false)
    expect(isSafeAddonMember('Other/Other.toc')).toBe(false)
    expect(isSafeAddonMember('../Everlook.toc')).toBe(false)
    expect(isSafeAddonMember('Everlook/../../etc/passwd')).toBe(false)
    expect(isSafeAddonMember('/etc/passwd')).toBe(false)
    expect(isSafeAddonMember('Interface/AddOns/Evil.lua')).toBe(false)
    expect(() => assertSafeAddonArchive(['Everlook/everlook.lua'])).toThrow('Everlook/Everlook.toc')
    expect(() => assertSafeAddonArchive(['Everlook/Everlook.toc', '../outside.lua'])).toThrow('unsafe path')
  })

  it('keeps resolved children inside AddOns', () => {
    const addons = path.join(os.tmpdir(), 'wow', '_forever_', 'Interface', 'AddOns')
    expect(isPathInside(addons, path.join(addons, 'Everlook'))).toBe(true)
    expect(isPathInside(addons, path.join(addons, 'Everlook', 'Everlook.toc'))).toBe(true)
    expect(isPathInside(addons, path.join(addons, '..', '..', 'WTF'))).toBe(false)
    expect(isPathInside(addons, path.join(addons, '..', 'WTF'))).toBe(false)
  })

  it('maps a SavedVariables world file to the flavor AddOns folder', () => {
    const wow = path.join(os.tmpdir(), 'Program Files (x86)', 'World of Warcraft')
    const forever = path.join(wow, '_forever_', 'WTF', 'Account', '1', 'SavedVariables', 'Everlook.lua')
    expect(addonsDirectoryFromWorldFile(forever)).toBe(
      path.join(wow, '_forever_', 'Interface', 'AddOns')
    )
    const retail = path.join(wow, '_retail_', 'WTF', 'Account', '1', 'SavedVariables', 'Everlook.lua')
    expect(addonsDirectoryFromWorldFile(retail)).toBe(
      path.join(wow, '_retail_', 'Interface', 'AddOns')
    )
    const beta = path.join(wow, '_classic_beta_', 'WTF', 'Account', '1802535#1', 'SavedVariables', 'Everlook.lua')
    expect(addonsDirectoryFromWorldFile(beta)).toBe(
      path.join(wow, '_classic_beta_', 'Interface', 'AddOns')
    )
    expect(addonsDirectoryFromWorldFile(path.join(os.tmpdir(), 'Everlook.lua'))).toBeNull()
    const accountNamedLikeFlavor = path.join(
      wow,
      '_forever_',
      'WTF',
      'Account',
      '_main_',
      'SavedVariables',
      'Everlook.lua'
    )
    expect(addonsDirectoryFromWorldFile(accountNamedLikeFlavor)).toBe(
      path.join(wow, '_forever_', 'Interface', 'AddOns')
    )
    expect(
      addonsDirectoryFromWorldFile(
        path.join(wow, 'WTF', 'Account', '_main_', 'SavedVariables', 'Everlook.lua')
      )
    ).toBeNull()
  })

  it('lists one AddOns folder when a root is a symlink to the same install', async () => {
    const root = await makeTemp()
    const wow = path.join(root, 'wow')
    const flavor = path.join(wow, '_forever_')
    await mkdir(flavor, { recursive: true })
    const linked = path.join(root, 'linked-wow')
    await symlink(wow, linked, process.platform === 'win32' ? 'junction' : 'dir')
    const worldFile = path.join(flavor, 'WTF', 'Account', '1', 'SavedVariables', 'Everlook.lua')
    await mkdir(path.dirname(worldFile), { recursive: true })
    await writeFile(worldFile, 'EverlookDB = {}\n')

    const directories = await discoverAddonsDirectories([worldFile], [linked, wow])
    expect(directories).toEqual([path.join(flavor, 'Interface', 'AddOns')])
  })
})

describe('installAddon', () => {
  it('extracts into AddOns, keeps the signing token, leaves no backup, and verifies the toc', async () => {
    const root = await makeTemp()
    const archive = await packFixture(root)
    const addons = path.join(root, 'Interface', 'AddOns')
    const existing = path.join(addons, 'Everlook')
    await mkdir(existing, { recursive: true })
    await writeFile(path.join(existing, 'Everlook.toc'), '## Version: 0.1.0\n')
    const token = 'local _, Everlook = ...\nEverlook.config = {}\nEverlook.config.token = "abc"\n'
    await writeFile(path.join(existing, 'sign.lua'), token)
    await mkdir(path.join(addons, 'Everlook.bak-2026-01-01T00-00-00-000Z'))
    const bytes = await readFile(archive)
    const result = await installAddon({
      downloadUrl: 'https://everlook.ing/download/addon',
      addonsDirectory: addons,
      userDataDirectory: path.join(root, 'user-data'),
      fetchImpl: async () => new Response(bytes, { status: 200 })
    })

    expect(result.version).toBe('0.2.0')
    expect(result.skipped).toBe(false)
    expect(result.gitCheckout).toBe(false)
    expect(await readFile(path.join(addons, 'Everlook', 'Everlook.toc'), 'utf8')).toContain('0.2.0')
    const names = await readdir(addons)
    expect(names.some((name) => name.startsWith('Everlook.bak-'))).toBe(false)
    expect(names).toContain('Everlook')
    expect(await readFile(path.join(addons, 'Everlook', 'sign.lua'), 'utf8')).toBe(token)
  })

  it.skipIf(process.platform !== 'linux')('installs when AddOns is on another filesystem', async () => {
    const userDataDev = (await stat(os.tmpdir())).dev
    const gameDev = (await stat('/dev/shm')).dev
    expect(gameDev).not.toBe(userDataDev)

    const root = await makeTemp()
    const game = await mkdtemp(path.join('/dev/shm', 'everlook-addons-'))
    temporaryDirectories.push(game)
    const archive = await packFixture(root)
    const addons = path.join(game, 'Interface', 'AddOns')
    const existing = path.join(addons, 'Everlook')
    await mkdir(existing, { recursive: true })
    await writeFile(path.join(existing, 'Everlook.toc'), '## Version: 0.1.0\n')
    const token = 'local _, Everlook = ...\nEverlook.config = {}\nEverlook.config.token = "abc"\n'
    await writeFile(path.join(existing, 'sign.lua'), token)
    const bytes = await readFile(archive)

    const result = await installAddon({
      downloadUrl: 'https://everlook.ing/download/addon',
      addonsDirectory: addons,
      userDataDirectory: path.join(root, 'user-data'),
      fetchImpl: async () => new Response(bytes, { status: 200 })
    })

    expect(result.version).toBe('0.2.0')
    expect(result.skipped).toBe(false)
    expect(await readFile(path.join(addons, 'Everlook', 'Everlook.toc'), 'utf8')).toContain('0.2.0')
    expect(await readFile(path.join(addons, 'Everlook', 'sign.lua'), 'utf8')).toBe(token)
    const names = await readdir(addons)
    expect(names.some((name) => name.startsWith('Everlook.bak-'))).toBe(false)
    expect(names).toEqual(['Everlook'])
  })

  it('installs every module folder, removes modules the release dropped, and leaves a symlinked module alone', async () => {
    const root = await makeTemp()
    const archive = await packFixture(root, [], ['Everlook_SellJunk', 'Everlook_SmartIsland'])
    const addons = path.join(root, 'Interface', 'AddOns')
    const existing = path.join(addons, 'Everlook')
    await mkdir(existing, { recursive: true })
    await writeFile(path.join(existing, 'Everlook.toc'), '## Version: 0.1.0\n')
    const token = 'local _, Everlook = ...\nEverlook.config = {}\nEverlook.config.token = "abc"\n'
    await writeFile(path.join(existing, 'sign.lua'), token)
    await mkdir(path.join(addons, 'Everlook_SellJunk'))
    await writeFile(path.join(addons, 'Everlook_SellJunk', 'Everlook_SellJunk.toc'), '## Version: 0.1.0\n')
    await mkdir(path.join(addons, 'Everlook_Dropped'))
    await writeFile(path.join(addons, 'Everlook_Dropped', 'Everlook_Dropped.toc'), '## Version: 0.1.0\n')
    const live = path.join(root, 'dev-island')
    await mkdir(live)
    await writeFile(path.join(live, 'Everlook_SmartIsland.toc'), '## Version: 9.9.9\n')
    await symlink(live, path.join(addons, 'Everlook_SmartIsland'), process.platform === 'win32' ? 'junction' : 'dir')
    await mkdir(path.join(addons, 'OtherAddon'))
    const bytes = await readFile(archive)

    const result = await installAddon({
      downloadUrl: 'https://everlook.ing/download/addon',
      addonsDirectory: addons,
      userDataDirectory: path.join(root, 'user-data'),
      fetchImpl: async () => new Response(bytes, { status: 200 })
    })

    expect(result.version).toBe('0.2.0')
    expect((await readdir(addons)).sort()).toEqual(['Everlook', 'Everlook_SellJunk', 'Everlook_SmartIsland', 'OtherAddon'])
    expect(await readFile(path.join(addons, 'Everlook_SellJunk', 'Everlook_SellJunk.toc'), 'utf8')).toContain('0.2.0')
    expect(await readFile(path.join(addons, 'Everlook_SmartIsland', 'Everlook_SmartIsland.toc'), 'utf8')).toContain('9.9.9')
    expect(await readFile(path.join(addons, 'Everlook', 'sign.lua'), 'utf8')).toBe(token)
  })

  it('refuses an archive whose module folders come without Everlook/', async () => {
    const root = await makeTemp()
    const stage = path.join(root, 'stage')
    await mkdir(path.join(stage, 'Everlook_SellJunk'), { recursive: true })
    await writeFile(path.join(stage, 'Everlook_SellJunk', 'Everlook_SellJunk.toc'), '## Version: 0.2.0\n')
    const archive = path.join(root, 'modules.tar.gz')
    await execFileAsync('tar', ['-czf', `../${path.basename(archive)}`, 'Everlook_SellJunk'], { cwd: stage })
    const bytes = await readFile(archive)

    await expect(
      installAddon({
        downloadUrl: 'https://everlook.ing/download/addon',
        addonsDirectory: path.join(root, 'Interface', 'AddOns'),
        userDataDirectory: path.join(root, 'user-data'),
        fetchImpl: async () => new Response(bytes, { status: 200 })
      })
    ).rejects.toThrow('Everlook/Everlook.toc')
  })

  it('does not copy a sign.lua stub without a token', async () => {
    const root = await makeTemp()
    const archive = await packFixture(root)
    const addons = path.join(root, 'Interface', 'AddOns')
    const existing = path.join(addons, 'Everlook')
    await mkdir(existing, { recursive: true })
    await writeFile(path.join(existing, 'Everlook.toc'), '## Version: 0.1.0\n')
    await writeFile(path.join(existing, 'sign.lua'), '-- the app replaces this file\n')
    const bytes = await readFile(archive)
    await installAddon({
      downloadUrl: 'https://everlook.ing/download/addon',
      addonsDirectory: addons,
      userDataDirectory: path.join(root, 'user-data'),
      fetchImpl: async () => new Response(bytes, { status: 200 })
    })
    const copied = await readFile(path.join(addons, 'Everlook', 'sign.lua'), 'utf8').catch(() => '')
    expect(copied).not.toContain('Everlook.config.token')
  })

  it('skips install and leaves a symlink AddOns/Everlook in place', async () => {
    const root = await makeTemp()
    const addons = path.join(root, 'Interface', 'AddOns')
    const live = path.join(root, 'dev-everlook')
    await mkdir(live, { recursive: true })
    await mkdir(addons, { recursive: true })
    await writeFile(path.join(live, 'Everlook.toc'), '## Version: 9.9.9\n')
    await symlink(live, path.join(addons, 'Everlook'), process.platform === 'win32' ? 'junction' : 'dir')

    const result = await installAddon({
      downloadUrl: 'https://everlook.ing/download/addon',
      addonsDirectory: addons,
      userDataDirectory: path.join(root, 'user-data'),
      fetchImpl: async () => {
        throw new Error('download should not run for a symlink install')
      }
    })

    expect(result.skipped).toBe(true)
    expect(result.gitCheckout).toBe(false)
    expect(result.version).toBe('9.9.9')
    expect(await readFile(path.join(addons, 'Everlook', 'Everlook.toc'), 'utf8')).toContain('9.9.9')
    const names = await readdir(addons)
    expect(names.some((name) => name.startsWith('Everlook.bak-'))).toBe(false)
  })

  it('refuses an archive that would extract outside Everlook/', async () => {
    const root = await makeTemp()
    const stage = path.join(root, 'stage')
    await mkdir(path.join(stage, 'Everlook'), { recursive: true })
    await writeFile(path.join(stage, 'Everlook', 'Everlook.toc'), '## Version: 0.2.0\n')
    await writeFile(path.join(stage, 'outside.lua'), 'bad\n')
    const archive = path.join(root, 'evil.tar.gz')
    await execFileAsync('tar', ['-czf', `../${path.basename(archive)}`, 'Everlook', 'outside.lua'], { cwd: stage })
    const bytes = await readFile(archive)
    const addons = path.join(root, 'Interface', 'AddOns')

    await expect(
      installAddon({
        downloadUrl: 'https://everlook.ing/download/addon',
        addonsDirectory: addons,
        userDataDirectory: path.join(root, 'user-data'),
        fetchImpl: async () => new Response(bytes, { status: 200 })
      })
    ).rejects.toThrow('unsafe path')
  })

  it('composes the Everlook download URL', () => {
    expect(addonDownloadUrl('https://everlook.ing/')).toBe(
      'https://everlook.ing/download/addon'
    )
    expect(addonManifestUrl('https://everlook.ing/')).toBe(
      'https://everlook.ing/download/addon.json'
    )
  })
})

describe('installed Everlook detection', () => {
  it('reads Version, Interface, and Title from the TOC', () => {
    expect(
      parseToc('## Interface: 110007, 120105\n## Title: Everlook\n## Version: 0.2.0\n')
    ).toEqual({
      title: 'Everlook',
      version: '0.2.0',
      interface: '110007, 120105'
    })
  })

  it('treats a TOC plus world.lua as installed without SavedVariables everlook.lua', async () => {
    const root = await makeTemp()
    const addons = path.join(root, 'Interface', 'AddOns')
    const addon = path.join(addons, 'Everlook')
    await mkdir(addon, { recursive: true })
    await writeFile(
      path.join(addon, 'Everlook.toc'),
      '## Title: Everlook\n## Version: 0.4.0\n## Interface: 16001\n'
    )
    await writeFile(path.join(addon, 'world.lua'), 'local _, Everlook = ...\n')

    const installed = await inspectInstalledAddon(addons)

    expect(installed.present).toBe(true)
    expect(installed.version).toBe('0.4.0')
  })

  it('treats a TOC without world.lua as missing', async () => {
    const root = await makeTemp()
    const addons = path.join(root, 'Interface', 'AddOns')
    const addon = path.join(addons, 'Everlook')
    await mkdir(addon, { recursive: true })
    await writeFile(
      path.join(addon, 'Everlook.toc'),
      '## Title: Everlook\n## Version: 0.4.0\n## Interface: 16001\n'
    )

    const installed = await inspectInstalledAddon(addons)

    expect(installed.present).toBe(false)
  })

  it('treats a folder without a Everlook TOC as missing', async () => {
    const root = await makeTemp()
    const addons = path.join(root, 'Interface', 'AddOns')
    await mkdir(path.join(addons, 'Everlook'), { recursive: true })
    await writeFile(path.join(addons, 'Everlook', 'notes.txt'), 'not an addon')

    const installed = await inspectInstalledAddon(addons)

    expect(installed.present).toBe(false)
    expect(addonStatusFromProbe(installed, { version: '0.2.0', title: 'Everlook', interface: null, available: true })).toBe(
      'missing'
    )
  })

  it('marks a git symlink checkout so extract is skipped', async () => {
    const root = await makeTemp()
    const addons = path.join(root, 'Interface', 'AddOns')
    const live = path.join(root, 'dev-everlook')
    await mkdir(path.join(live, '.git'), { recursive: true })
    await mkdir(addons, { recursive: true })
    await writeFile(
      path.join(live, 'Everlook.toc'),
      '## Title: Everlook\n## Version: 0.2.0\n## Interface: 120105\n'
    )
    await writeFile(path.join(live, 'world.lua'), 'local _, Everlook = ...\n')
    await symlink(live, path.join(addons, 'Everlook'), process.platform === 'win32' ? 'junction' : 'dir')

    const installed = await inspectInstalledAddon(addons)

    expect(installed.present).toBe(true)
    expect(installed.gitCheckout).toBe(true)
    expect(installed.symlink).toBe(true)
    expect(addonStatusFromProbe(installed, { version: '0.3.0', title: 'Everlook', interface: null, available: true })).toBe(
      'git'
    )
  })

  it('compares published tarball versions from the Everlook manifest', async () => {
    expect(compareAddonVersions('0.1.0', '0.2.0')).toBe(-1)
    expect(compareAddonVersions('0.2.0', '0.2.0')).toBe(0)
    const published = await fetchPublishedAddon('https://everlook.ing', async () =>
      new Response(JSON.stringify({ title: 'Everlook', version: '0.2.0', available: true }), {
        status: 200
      })
    )
    expect(published.version).toBe('0.2.0')
  })
})
