import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { UpdateState } from '../shared/types'
import {
  AppUpdater,
  canInstallUpdate,
  desktopUpdaterKind,
  downloadPercentOf,
  formatUpdateError,
  type AutoUpdaterPort,
  updateFeedUrl,
  updatesEnabled,
  DEFAULT_UPDATE_FEED_URL
} from './updater'

function fakeUpdater(): AutoUpdaterPort & EventEmitter {
  const emitter = new EventEmitter()
  return Object.assign(emitter, {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    forceDevUpdateConfig: false,
    setFeedURL: vi.fn(),
    checkForUpdates: vi.fn(async () => undefined),
    quitAndInstall: vi.fn()
  }) as AutoUpdaterPort & EventEmitter
}

function createUpdater(
  autoUpdater: AutoUpdaterPort,
  overrides: {
    enabled?: boolean
    isUploading?: () => boolean
    promptToRestart?: (version: string) => Promise<boolean>
    onState?: (state: UpdateState) => void
  } = {}
): AppUpdater {
  return new AppUpdater(autoUpdater, {
    currentVersion: '0.1.3',
    enabled: overrides.enabled ?? true,
    forceDevUpdateConfig: false,
    feedUrl: 'https://everlook.ing/updates',
    isUploading: overrides.isUploading ?? (() => false),
    onState: overrides.onState ?? vi.fn<(state: UpdateState) => void>(),
    promptToRestart: overrides.promptToRestart ?? (async () => false)
  })
}

describe('update feed', () => {
  it('defaults to the Everlook generic provider URL', () => {
    expect(updateFeedUrl({})).toBe(DEFAULT_UPDATE_FEED_URL)
  })

  it('uses EVERLOOK_UPDATE_URL without a trailing slash', () => {
    expect(updateFeedUrl({ EVERLOOK_UPDATE_URL: 'http://127.0.0.1:8765/updates/' })).toBe(
      'http://127.0.0.1:8765/updates'
    )
  })

  it('enables unpackaged checks only when a feed override is set', () => {
    expect(updatesEnabled(false, {})).toBe(false)
    expect(updatesEnabled(false, { EVERLOOK_UPDATE_URL: 'http://127.0.0.1:8765' })).toBe(true)
    expect(updatesEnabled(true, {})).toBe(true)
  })

  it('does not install while an upload is running', () => {
    expect(canInstallUpdate('ready', true)).toBe(false)
    expect(canInstallUpdate('ready', false)).toBe(true)
    expect(canInstallUpdate('downloading', false)).toBe(false)
  })

  it('uses a manual download on packaged macOS even when an automatic feed is allowed', () => {
    expect(desktopUpdaterKind({ automaticUpdates: true, packaged: true, platform: 'darwin' })).toBe('manual')
    expect(desktopUpdaterKind({ automaticUpdates: false, packaged: true, platform: 'darwin' })).toBe('manual')
    expect(desktopUpdaterKind({ automaticUpdates: true, packaged: true, platform: 'linux' })).toBe('automatic')
    expect(desktopUpdaterKind({ automaticUpdates: true, packaged: true, platform: 'win32' })).toBe('automatic')
    expect(desktopUpdaterKind({ automaticUpdates: false, packaged: false, platform: 'darwin' })).toBe('none')
    expect(desktopUpdaterKind({ automaticUpdates: false, packaged: true, platform: 'linux' })).toBe('none')
  })
})

describe('downloadPercentOf', () => {
  it('rounds a finite percent into 0-100', () => {
    expect(downloadPercentOf({ percent: 41.7 })).toBe(42)
    expect(downloadPercentOf({ percent: -4 })).toBe(0)
    expect(downloadPercentOf({ percent: 140 })).toBe(100)
    expect(downloadPercentOf({ percent: Number.NaN })).toBeNull()
    expect(downloadPercentOf({})).toBeNull()
  })
})

describe('formatUpdateError', () => {
  it('names a missing updater YAML as a 404', () => {
    const error = Object.assign(
      new Error('Cannot find channel "latest-linux.yml" update info: HttpError: 404 Not Found'),
      { code: 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND' }
    )
    expect(formatUpdateError(error)).toBe(
      'The update feed was not found (404): Cannot find channel "latest-linux.yml" update info: HttpError: 404 Not Found'
    )
  })

  it('names a network failure', () => {
    expect(formatUpdateError(new Error('net::ERR_INTERNET_DISCONNECTED'))).toBe(
      'Could not reach the update feed: net::ERR_INTERNET_DISCONNECTED'
    )
  })

  it('names an unsigned or checksum failure', () => {
    const error = Object.assign(new Error('New version 0.1.4 is not signed by the application owner'), {
      code: 'ERR_UPDATER_INVALID_SIGNATURE'
    })
    expect(formatUpdateError(error)).toBe(
      'The update could not be verified: New version 0.1.4 is not signed by the application owner'
    )
  })

  it('keeps an unrecognized first-line message', () => {
    expect(formatUpdateError(new Error('disk full\nmore detail'))).toBe('disk full')
  })
})

describe('AppUpdater', () => {
  it('closes without installing or quitting', () => {
    const autoUpdater = fakeUpdater()
    const updater = createUpdater(autoUpdater)
    updater.close()
    expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled()
    expect(updater.getState().status).toBe('idle')
  })

  it('starts unpackaged builds as unavailable without contacting the feed', async () => {
    const autoUpdater = fakeUpdater()
    const updater = createUpdater(autoUpdater, { enabled: false })
    expect(updater.getState().status).toBe('unavailable')
    updater.start()
    await updater.check()
    expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled()
    expect(updater.getState()).toMatchObject({ status: 'unavailable', error: null })
  })

  it('records download percent and refuses to install mid-upload', async () => {
    const autoUpdater = fakeUpdater()
    const promptToRestart = vi.fn(async () => true)
    const updater = createUpdater(autoUpdater, {
      isUploading: () => true,
      promptToRestart
    })

    updater.start()
    expect(autoUpdater.setFeedURL).toHaveBeenCalledWith({
      provider: 'generic',
      url: 'https://everlook.ing/updates'
    })
    expect(autoUpdater.autoDownload).toBe(true)

    autoUpdater.emit('update-available', { version: '0.2.0' })
    autoUpdater.emit('download-progress', { percent: 41.2 })
    expect(updater.getState()).toMatchObject({
      status: 'downloading',
      availableVersion: '0.2.0',
      downloadPercent: 41
    })

    autoUpdater.emit('update-downloaded', { version: '0.2.0' })
    await Promise.resolve()
    expect(updater.getState()).toMatchObject({
      status: 'ready',
      availableVersion: '0.2.0',
      downloadPercent: 100
    })
    expect(promptToRestart).not.toHaveBeenCalled()
    await expect(updater.install()).rejects.toThrow(
      'Wait for the current upload to finish before restarting.'
    )
    expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled()
  })

  it('prompts to restart after the update is downloaded and no upload is running', async () => {
    const autoUpdater = fakeUpdater()
    const updater = createUpdater(autoUpdater, {
      promptToRestart: async () => true
    })

    updater.start()
    autoUpdater.emit('update-downloaded', { version: '0.2.0' })
    await Promise.resolve()
    await Promise.resolve()
    expect(updater.getState()).toMatchObject({ status: 'ready', availableVersion: '0.2.0' })
    expect(autoUpdater.quitAndInstall).toHaveBeenCalledWith(false, true)
  })

  it('leaves a downloaded update ready when the renderer will prompt', async () => {
    const autoUpdater = fakeUpdater()
    const updater = createUpdater(autoUpdater)

    updater.start()
    autoUpdater.emit('update-downloaded', { version: '0.2.0' })
    await Promise.resolve()
    await Promise.resolve()
    expect(updater.getState()).toMatchObject({ status: 'ready', availableVersion: '0.2.0' })
    expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled()
  })

  it('marks the install current when the feed has no newer build', () => {
    const autoUpdater = fakeUpdater()
    const updater = createUpdater(autoUpdater)
    updater.start()
    autoUpdater.emit('update-not-available')
    expect(updater.getState()).toMatchObject({
      status: 'current',
      availableVersion: null,
      error: null
    })
  })

  it('surfaces feed errors on the update state', () => {
    const autoUpdater = fakeUpdater()
    const updater = createUpdater(autoUpdater)
    updater.start()
    autoUpdater.emit(
      'error',
      Object.assign(new Error('Cannot find channel "latest-linux.yml" update info'), {
        code: 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND'
      })
    )
    expect(updater.getState().status).toBe('error')
    expect(updater.getState().error).toContain('The update feed was not found (404)')
  })

  it('formats a rejected check as an error state', async () => {
    const autoUpdater = fakeUpdater()
    autoUpdater.checkForUpdates = vi.fn(async () => {
      throw Object.assign(new Error('Cannot find channel "latest-linux.yml" update info'), {
        code: 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND'
      })
    })
    const updater = createUpdater(autoUpdater)
    await updater.check()
    expect(updater.getState().status).toBe('error')
    expect(updater.getState().error).toContain('The update feed was not found (404)')
  })

  it('does not contact the feed when updates are disabled', async () => {
    const autoUpdater = fakeUpdater()
    const updater = createUpdater(autoUpdater, { enabled: false })

    updater.start()
    await updater.check()
    expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled()
  })
})
