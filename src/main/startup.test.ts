import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { configureStartup, readStartup } from './startup'

const temporaryDirectories: string[] = []
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })))
})
async function fixture() {
  const homeDirectory = await mkdtemp(path.join(os.tmpdir(), 'everlook-startup-'))
  temporaryDirectories.push(homeDirectory)
  return { platform: 'linux' as const, packaged: true, executable: '/opt/Everlook.AppImage', homeDirectory }
}

describe('login startup', () => {
  it.skipIf(process.platform === 'win32')('starts disabled and creates/removes only its XDG autostart desktop entry', async () => {
    const options = await fixture()
    const file = path.join(options.homeDirectory, '.config', 'autostart', 'dev.csfh.everlook.desktop')
    expect(await readStartup(options)).toEqual({ supported: true, enabled: false, error: null })
    expect(await configureStartup({ ...options, enabled: true })).toEqual({ supported: true, enabled: true, error: null })
    expect(await readFile(file, 'utf8')).toContain('Exec="/opt/Everlook.AppImage" --background\n')
    expect(await readStartup(options)).toEqual({ supported: true, enabled: true, error: null })
    const other = path.join(path.dirname(file), 'other.desktop')
    await writeFile(other, 'other app')
    expect(await configureStartup({ ...options, enabled: false })).toEqual({ supported: true, enabled: false, error: null })
    await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(other, 'utf8')).toBe('other app')
  })

  it.skipIf(process.platform === 'win32')('honors an injected XDG config directory and safely quotes special characters and percent codes', async () => {
    const options = await fixture()
    const configDirectory = path.join(options.homeDirectory, 'config elsewhere')
    const executable = '/opt/a space/50%u "$cash`back\\slash.AppImage'
    expect(await configureStartup({ ...options, configDirectory, executable, enabled: true })).toEqual({ supported: true, enabled: true, error: null })
    const contents = await readFile(path.join(configDirectory, 'autostart', 'dev.csfh.everlook.desktop'), 'utf8')
    const line = contents.split('\n').find((value) => value.startsWith('Exec='))
    // Decode desktop-entry string escaping, then quoted argument escaping and field codes.
    const decoded = line?.slice('Exec="'.length, -'" --background'.length)
      .replaceAll('\\\\', '\\')
      .replace(/\\(["`$\\])/g, '$1')
      .replaceAll('%%', '%')
    expect(decoded).toBe(executable)
  })

  it.skipIf(process.platform === 'win32')('rejects injected lines, relative paths and the desktop spec forbidden equals character without creating an entry', async () => {
    const options = await fixture()
    for (const executable of ['/opt/app\nHidden=true', 'everlook', '/opt/app=name']) {
      expect(await configureStartup({ ...options, executable, enabled: true })).toMatchObject({ enabled: false, error: expect.any(String) })
    }
    expect(await readStartup(options)).toEqual({ supported: true, enabled: false, error: null })
    expect(await configureStartup({ ...options, configDirectory: 'relative', enabled: true })).toMatchObject({ enabled: false, error: expect.any(String) })
  })

  it.each(['linux', 'darwin', 'win32'] as const)('never changes login settings in development on %s', async (platform) => {
    const options = await fixture()
    const setLoginItemSettings = vi.fn()
    const getLoginItemSettings = vi.fn(() => ({ openAtLogin: true }))
    expect(await readStartup({ ...options, platform, packaged: false, setLoginItemSettings, getLoginItemSettings })).toEqual({ supported: false, enabled: false, error: null })
    expect(await configureStartup({ ...options, platform, packaged: false, enabled: true, setLoginItemSettings, getLoginItemSettings })).toMatchObject({ supported: false, enabled: false, error: expect.any(String) })
    expect(setLoginItemSettings).not.toHaveBeenCalled()
    expect(getLoginItemSettings).not.toHaveBeenCalled()
  })

  it('passes the same Windows executable and arguments when writing and reading login settings', async () => {
    const options = await fixture()
    let openAtLogin = false
    const setLoginItemSettings = vi.fn((settings: { openAtLogin: boolean }) => { openAtLogin = settings.openAtLogin })
    const getLoginItemSettings = vi.fn(() => ({ openAtLogin, executableWillLaunchAtLogin: openAtLogin }))
    const executable = 'C:\\Program Files\\Everlook\\Everlook.exe'
    expect(await configureStartup({ ...options, platform: 'win32', executable, enabled: true, setLoginItemSettings, getLoginItemSettings })).toEqual({ supported: true, enabled: true, error: null })
    expect(setLoginItemSettings).toHaveBeenCalledWith({ openAtLogin: true, enabled: true, path: executable, args: ['--background'] })
    expect(getLoginItemSettings).toHaveBeenCalledWith({ path: executable, args: ['--background'] })
    expect(await configureStartup({ ...options, platform: 'win32', executable, enabled: false, setLoginItemSettings, getLoginItemSettings })).toEqual({ supported: true, enabled: false, error: null })
  })

  it('uses current Mac login APIs and reports required OS approval', async () => {
    const options = await fixture()
    const setLoginItemSettings = vi.fn()
    const getLoginItemSettings = vi.fn(() => ({ openAtLogin: false, status: 'requires-approval' }))
    const result = await configureStartup({ ...options, platform: 'darwin', enabled: true, setLoginItemSettings, getLoginItemSettings })
    expect(setLoginItemSettings).toHaveBeenCalledWith({ openAtLogin: true })
    expect(getLoginItemSettings).toHaveBeenCalledWith()
    expect(result).toMatchObject({ supported: true, enabled: false, error: expect.stringContaining('System Settings') })
  })

  it('does not report success for a blocked Windows login item or a no-op setter', async () => {
    const options = await fixture()
    const getLoginItemSettings = () => ({ openAtLogin: true, executableWillLaunchAtLogin: false })
    expect(await readStartup({ ...options, platform: 'win32', getLoginItemSettings })).toMatchObject({ enabled: false, error: expect.any(String) })
    expect(await configureStartup({ ...options, platform: 'win32', enabled: true, setLoginItemSettings: () => {}, getLoginItemSettings: () => ({ openAtLogin: false }) })).toMatchObject({ enabled: false, error: expect.any(String) })
  })

  it('surfaces read/write failures and retains observed state when native setup fails', async () => {
    const options = await fixture()
    const configDirectory = path.join(options.homeDirectory, 'not-a-directory')
    await writeFile(configDirectory, 'file')
    expect(await configureStartup({ ...options, configDirectory, enabled: true })).toMatchObject({ supported: true, enabled: false, error: expect.any(String) })
    expect(await configureStartup({ ...options, platform: 'darwin', enabled: false, getLoginItemSettings: () => ({ openAtLogin: true }), setLoginItemSettings: () => { throw new Error('permission denied') } })).toMatchObject({ enabled: true, error: expect.any(String) })
    expect(await readStartup({ ...options, platform: 'darwin' })).toMatchObject({ supported: true, enabled: false, error: expect.any(String) })
  })

  it.skipIf(process.platform === 'win32')('detects a stale or disabled Linux entry', async () => {
    const options = await fixture()
    const directory = path.join(options.homeDirectory, '.config', 'autostart')
    await mkdir(directory, { recursive: true })
    const file = path.join(directory, 'dev.csfh.everlook.desktop')
    await writeFile(file, '[Desktop Entry]\nType=Application\nHidden=true\nExec="/opt/Everlook.AppImage" --background\n')
    expect(await readStartup(options)).toMatchObject({ enabled: false, error: null })
    await writeFile(file, '[Desktop Entry]\nType=Application\nExec="/old/app" --background\n')
    expect(await readStartup(options)).toMatchObject({ enabled: false, error: expect.any(String) })
  })
})
