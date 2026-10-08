import { describe, expect, it, vi } from 'vitest'
import type { AppState, FileState, WowLauncherStatus } from '../shared/types'
import { buildTrayMenu, trayStatus } from './tray-menu'

function file(overrides: Partial<FileState> = {}): FileState {
  return {
    path: '/wow/Everlook.lua',
    account: 'ACCOUNT1',
    lastDetectedAt: null,
    lastUploadedAt: null,
    lastUploadedHash: null,
    status: 'watching',
    error: null,
    response: null,
    signed: null,
    ...overrides
  }
}

function state(overrides: {
  authenticated?: boolean
  files?: FileState[]
  autoWatch?: boolean
  wow?: WowLauncherStatus
}): Pick<AppState, 'authenticated' | 'files' | 'settings' | 'wow'> {
  return {
    authenticated: overrides.authenticated ?? true,
    files: overrides.files ?? [file()],
    settings: { autoWatch: overrides.autoWatch ?? true } as AppState['settings'],
    wow: { status: overrides.wow ?? 'idle', scriptPath: null, error: null }
  }
}

describe('trayStatus', () => {
  it('says when nobody is signed in', () => {
    expect(trayStatus(state({ authenticated: false })).label).toBe('Signed out')
  })

  it('reuses the upload summary for the headline', () => {
    expect(trayStatus(state({ files: [file(), file({ path: '/b' })] })).label).toBe(
      'Watching 2 files'
    )
    expect(trayStatus(state({ files: [file({ status: 'uploading' })] })).label).toBe(
      'Uploading 1 file'
    )
    expect(trayStatus(state({ files: [file({ status: 'error' })] })).label).toBe(
      '1 file failed to upload'
    )
  })

  it('only allows Upload all with a signed-in account and idle files', () => {
    expect(trayStatus(state({})).canUpload).toBe(true)
    expect(trayStatus(state({ authenticated: false })).canUpload).toBe(false)
    expect(trayStatus(state({ files: [] })).canUpload).toBe(false)
    expect(trayStatus(state({ files: [file({ status: 'uploading' })] })).canUpload).toBe(false)
  })
})

describe('buildTrayMenu', () => {
  const handlers = () => ({
    uploadAll: vi.fn(),
    toggleWow: vi.fn(),
    open: vi.fn(),
    quit: vi.fn()
  })

  it('lists the status first, as a disabled line', () => {
    const menu = buildTrayMenu(trayStatus(state({})), handlers())
    expect(menu[0]).toMatchObject({ label: 'Watching 1 file', enabled: false })
  })

  it('wires each action to its handler', () => {
    const actions = handlers()
    const menu = buildTrayMenu(trayStatus(state({})), actions)
    const click = (label: string): void => {
      const item = menu.find((entry) => entry.label === label)
      expect(item, label).toBeDefined()
      ;(item?.click as () => void)()
    }
    click('Upload all')
    click('Launch WoW')
    click('Open Everlook')
    click('Quit Everlook')
    expect(actions.uploadAll).toHaveBeenCalledOnce()
    expect(actions.toggleWow).toHaveBeenCalledOnce()
    expect(actions.open).toHaveBeenCalledOnce()
    expect(actions.quit).toHaveBeenCalledOnce()
  })

  it('offers Stop WoW while the game runs and locks the item mid-change', () => {
    const running = buildTrayMenu(trayStatus(state({ wow: 'running' })), handlers())
    expect(running.find((entry) => entry.label === 'Stop WoW')?.enabled).toBe(true)
    const starting = buildTrayMenu(trayStatus(state({ wow: 'starting' })), handlers())
    expect(starting.find((entry) => entry.label === 'Launching…')?.enabled).toBe(false)
  })

  it('disables Upload all when it cannot run', () => {
    const menu = buildTrayMenu(trayStatus(state({ authenticated: false })), handlers())
    expect(menu.find((entry) => entry.label === 'Upload all')?.enabled).toBe(false)
  })
})
