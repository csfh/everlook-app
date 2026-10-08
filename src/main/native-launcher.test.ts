import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { discoverNativeLauncher, launchNativeBattleNet, validateNativeLauncher } from './native-launcher'

const temporaryDirectories: string[] = []
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })))
})
async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'everlook-native-'))
  temporaryDirectories.push(root)
  return root
}

describe('native Battle.net', () => {
  it('opens a selected readable executable directly and reports opened, not WoW running', async () => {
    const root = await fixture()
    const executable = path.join(root, 'Battle.net & launcher.exe')
    await writeFile(executable, 'executable')
    const openPath = vi.fn(async () => '')
    await expect(launchNativeBattleNet({ platform: 'win32', path: executable, openPath })).resolves.toEqual({ status: 'opened', path: executable })
    expect(openPath).toHaveBeenCalledExactlyOnceWith(executable)
  })

  it.skipIf(process.platform === 'win32')('accepts a Mac app directory and rejects a file masquerading as an app', async () => {
    const root = await fixture()
    const app = path.join(root, 'Battle.net.app')
    await mkdir(app)
    await expect(validateNativeLauncher({ platform: 'darwin', path: app })).resolves.toBe(app)
    const fake = path.join(root, 'Fake.app')
    await writeFile(fake, 'not a bundle')
    await expect(validateNativeLauncher({ platform: 'darwin', path: fake })).rejects.toThrow('directory')
  })

  it('rejects missing paths, directories on Windows, non-executables, and command strings', async () => {
    const root = await fixture()
    await expect(validateNativeLauncher({ platform: 'win32', path: path.join(root, 'missing.exe') })).rejects.toThrow('not found')
    await expect(validateNativeLauncher({ platform: 'win32', path: root })).rejects.toThrow('executable')
    const script = path.join(root, 'launcher.bat')
    await writeFile(script, 'echo hello')
    await expect(validateNativeLauncher({ platform: 'win32', path: script })).rejects.toThrow('.exe')
    await expect(validateNativeLauncher({ platform: 'win32', path: 'start Battle.net.exe' })).rejects.toThrow('absolute')
    await expect(validateNativeLauncher({ platform: 'darwin', path: '/Applications/Battle.net.app\nExec=bad' })).rejects.toThrow('path')
    await expect(validateNativeLauncher({ platform: 'linux', path: root })).rejects.toThrow('Windows and macOS')
  })

  it('never opens an unreadable executable', async () => {
    const openPath = vi.fn(async () => '')
    const fileSystem = {
      stat: async () => ({ isFile: () => true, isDirectory: () => false }),
      access: async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }) }
    }
    await expect(launchNativeBattleNet({ platform: 'win32', path: 'C:\\Battle.net.exe', openPath, fileSystem })).rejects.toThrow('readable')
    expect(openPath).not.toHaveBeenCalled()
  })

  it('propagates openPath failure strings and rejected promises', async () => {
    const root = await fixture()
    const executable = path.join(root, 'Battle.net.exe')
    await writeFile(executable, '')
    await expect(launchNativeBattleNet({ platform: 'win32', path: executable, openPath: async () => 'Access denied' })).rejects.toThrow('Access denied')
    await expect(launchNativeBattleNet({ platform: 'win32', path: executable, openPath: async () => { throw new Error('OS failure') } })).rejects.toThrow('OS failure')
  })

  it('discovers both Windows Program Files locations with case-insensitive environment names', async () => {
    const present = 'D:\\Program Files (x86)\\Battle.net\\Battle.net Launcher.exe'
    const fileSystem = {
      stat: async (candidate: string) => {
        if (candidate !== present) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
        return { isFile: () => true, isDirectory: () => false }
      },
      access: async () => undefined
    }
    await expect(discoverNativeLauncher({ platform: 'win32', homeDirectory: 'C:\\Users\\user', env: { ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'D:\\Program Files (x86)' }, fileSystem })).resolves.toBe(present)
  })

  it.skipIf(process.platform === 'win32')('discovers a Mac user app and returns null when none is installed', async () => {
    const root = await fixture()
    const app = path.join(root, 'Applications', 'Battle.net.app')
    await mkdir(app, { recursive: true })
    const fileSystem = {
      stat: async (candidate: string) => {
        if (candidate !== app) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
        return { isFile: () => false, isDirectory: () => true }
      },
      access: async () => undefined
    }
    await expect(discoverNativeLauncher({ platform: 'darwin', homeDirectory: root, fileSystem })).resolves.toBe(app)
    await expect(discoverNativeLauncher({ platform: 'linux', homeDirectory: root })).resolves.toBeNull()
    await expect(discoverNativeLauncher({ platform: 'darwin', homeDirectory: root, fileSystem: { ...fileSystem, stat: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }) } } })).resolves.toBeNull()
  })
})
