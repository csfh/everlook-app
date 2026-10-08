import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  accountName,
  buildInfoHasForeverProduct,
  commonWowRoots,
  discoverWorldFiles,
  discoverFromRoot,
  isForeverInstall,
  parseSteamLibraryFolders
} from './discovery'

const temporaryDirectories: string[] = []

/** The resolved path, because discovery returns resolved paths and macOS and Windows temp folders are links or short names. */
async function temporaryDirectory(prefix: string): Promise<string> {
  return realpath(await mkdtemp(path.join(os.tmpdir(), prefix)))
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })))
})

describe('Everlook discovery', () => {
  it('finds account world files below a WoW root and ignores backups', async () => {
    const root = await temporaryDirectory('everlook-discovery-')
    temporaryDirectories.push(root)
    const savedVariables = path.join(
      root,
      '_classic_beta_',
      'WTF',
      'Account',
      'ACCOUNT#1',
      'SavedVariables'
    )
    await mkdir(savedVariables, { recursive: true })
    const worldFile = path.join(savedVariables, 'Everlook.lua')
    await writeFile(worldFile, 'EverlookDB = {}')
    await writeFile(`${worldFile}.bak`, 'old')

    const result = await discoverFromRoot(root)
    expect(result).toEqual([worldFile])
    expect(accountName(result[0] ?? '')).toBe('ACCOUNT#1')
  })

  it('accepts a manually selected Everlook.lua only', async () => {
    const root = await temporaryDirectory('everlook-file-')
    temporaryDirectories.push(root)
    const worldFile = path.join(root, 'Everlook.lua')
    const backup = path.join(root, 'Everlook.lua.bak')
    await writeFile(worldFile, 'current')
    await writeFile(backup, 'backup')

    await expect(discoverFromRoot(worldFile)).resolves.toEqual([worldFile])
    await expect(discoverFromRoot(backup)).resolves.toEqual([])
  })

  it('ignores Classic Era world files under a shared WoW root', async () => {
    const root = await temporaryDirectory('everlook-era-')
    temporaryDirectories.push(root)
    const eraSaved = path.join(root, '_classic_era_', 'WTF', 'Account', 'ERA', 'SavedVariables')
    await mkdir(eraSaved, { recursive: true })
    await writeFile(path.join(eraSaved, 'Everlook.lua'), 'EverlookDB = {}')

    await expect(discoverFromRoot(root)).resolves.toEqual([])
  })

  it('reads extra Steam libraries from libraryfolders.vdf', () => {
    expect(
      parseSteamLibraryFolders(`"libraryfolders"
{
	"0"
	{
		"path"		"/home/user/.local/share/Steam"
	}
	"1"
	{
		"path"		"D:\\\\Games\\\\Steam"
	}
}`)
    ).toEqual(['/home/user/.local/share/Steam', 'D:\\Games\\Steam'])
  })

  it('treats wow_classic_beta as a Forever product', () => {
    expect(buildInfoHasForeverProduct('1.60.1.69893||wow_classic_beta')).toBe(true)
    expect(buildInfoHasForeverProduct('1.15.9.69722||wow_classic_era')).toBe(false)
  })

  it('finds a Proton Forever install from Steam libraries', async () => {
    const home = await temporaryDirectory('everlook-home-')
    temporaryDirectories.push(home)
    const extraLibrary = path.join(home, 'Games', 'Steam')
    const steam = path.join(home, '.local', 'share', 'Steam')
    const wow = path.join(
      extraLibrary,
      'steamapps',
      'compatdata',
      '2932643018',
      'pfx',
      'drive_c',
      'Program Files (x86)',
      'World of Warcraft'
    )
    const savedVariables = path.join(
      wow,
      '_classic_beta_',
      'WTF',
      'Account',
      'ACCOUNT#1',
      'SavedVariables'
    )
    await mkdir(savedVariables, { recursive: true })
    await mkdir(path.join(steam, 'steamapps'), { recursive: true })
    await writeFile(
      path.join(steam, 'steamapps', 'libraryfolders.vdf'),
      `"libraryfolders"
{
	"0" { "path"		"${steam}" }
	"1" { "path"		"${extraLibrary}" }
}`
    )
    await writeFile(path.join(wow, '.build.info'), '1.60.1.69893||wow_classic_beta\n')
    const worldFile = path.join(savedVariables, 'Everlook.lua')
    await writeFile(worldFile, 'EverlookDB = {}')

    const retailOnly = path.join(steam, 'steamapps', 'common', 'World of Warcraft')
    await mkdir(path.join(retailOnly, '_retail_'), { recursive: true })
    await writeFile(path.join(retailOnly, '.build.info'), '12.0.0||wow\n')

    await expect(isForeverInstall(wow)).resolves.toBe(true)
    await expect(isForeverInstall(retailOnly)).resolves.toBe(false)
    await expect(commonWowRoots(home, 'linux')).resolves.toEqual([wow])
    await expect(discoverWorldFiles(home, 'linux')).resolves.toEqual([worldFile])
  })

  it('finds a Battle.net Wine Forever install under Games', async () => {
    const home = await temporaryDirectory('everlook-bnet-')
    temporaryDirectories.push(home)
    const wow = path.join(
      home,
      'Games',
      'battlenet',
      'drive_c',
      'Program Files (x86)',
      'World of Warcraft'
    )
    const savedVariables = path.join(
      wow,
      '_classic_beta_',
      'WTF',
      'Account',
      'ACCOUNT#1',
      'SavedVariables'
    )
    await mkdir(savedVariables, { recursive: true })
    await writeFile(path.join(wow, '.build.info'), '1.60.1.69913||wow_classic_beta\n')
    const worldFile = path.join(savedVariables, 'Everlook.lua')
    await writeFile(worldFile, 'EverlookDB = {}')

    await expect(isForeverInstall(wow)).resolves.toBe(true)
    await expect(commonWowRoots(home, 'linux')).resolves.toEqual([wow])
    await expect(discoverWorldFiles(home, 'linux')).resolves.toEqual([worldFile])
  })

  it('finds a world file when the account folder is a symlink', async () => {
    const root = await temporaryDirectory('everlook-account-link-')
    temporaryDirectories.push(root)
    const accountRoot = path.join(root, '_forever_', 'WTF', 'Account')
    const realAccount = path.join(root, 'linked-account')
    await mkdir(path.join(realAccount, 'SavedVariables'), { recursive: true })
    await mkdir(accountRoot, { recursive: true })
    const worldFile = path.join(realAccount, 'SavedVariables', 'Everlook.lua')
    await writeFile(worldFile, 'EverlookDB = {}')
    const linkName = path.join(accountRoot, 'ACCOUNT#1')
    await symlink(realAccount, linkName, process.platform === 'win32' ? 'junction' : 'dir')
    const linkedFile = path.join(linkName, 'SavedVariables', 'Everlook.lua')

    await expect(discoverFromRoot(root)).resolves.toEqual([linkedFile])
    expect(accountName(linkedFile)).toBe('ACCOUNT#1')
    await expect(realpath(linkedFile)).resolves.toBe(await realpath(worldFile))
  })

  it('lists one install when Steam roots are symlinks to the same library', async () => {
    const home = await temporaryDirectory('everlook-steam-link-')
    temporaryDirectories.push(home)
    const steam = path.join(home, '.local', 'share', 'Steam')
    const wow = path.join(steam, 'steamapps', 'common', 'World of Warcraft')
    await mkdir(path.join(wow, '_forever_'), { recursive: true })
    await mkdir(path.join(home, '.steam'), { recursive: true })
    const linkType = process.platform === 'win32' ? 'junction' : 'dir'
    await symlink(steam, path.join(home, '.steam', 'steam'), linkType)
    await symlink(steam, path.join(home, '.steam', 'root'), linkType)

    await expect(commonWowRoots(home, 'linux')).resolves.toEqual([wow])
  })

  it('finds Forever under Flatpak Steam, Heroic, and Bottles', async () => {
    const home = await temporaryDirectory('everlook-launchers-')
    temporaryDirectories.push(home)
    const installs = [
      path.join(home, '.var', 'app', 'com.valvesoftware.Steam', 'data', 'Steam', 'steamapps', 'common', 'World of Warcraft'),
      path.join(home, 'Games', 'Heroic', 'Prefixes', 'wow', 'drive_c', 'Program Files (x86)', 'World of Warcraft'),
      path.join(home, '.var', 'app', 'com.heroicgameslauncher.hgl', 'config', 'heroic', 'Prefixes', 'wow', 'pfx', 'drive_c', 'Program Files (x86)', 'World of Warcraft'),
      path.join(home, '.local', 'share', 'bottles', 'bottles', 'wow', 'drive_c', 'Program Files (x86)', 'World of Warcraft'),
      path.join(home, '.var', 'app', 'com.usebottles.bottles', 'data', 'bottles', 'bottles', 'wow', 'drive_c', 'Program Files (x86)', 'World of Warcraft')
    ]
    const worldFiles = await Promise.all(installs.map(async (wow) => {
      const savedVariables = path.join(wow, '_forever_', 'WTF', 'Account', 'ACCOUNT#1', 'SavedVariables')
      await mkdir(savedVariables, { recursive: true })
      const worldFile = path.join(savedVariables, 'Everlook.lua')
      await writeFile(worldFile, 'EverlookDB = {}')
      return worldFile
    }))

    await expect(commonWowRoots(home, 'linux')).resolves.toEqual([...installs].sort())
    await expect(discoverWorldFiles(home, 'linux')).resolves.toEqual([...worldFiles].sort())
  })
})
