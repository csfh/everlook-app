import type { UpdateState, UpdateStatus } from '../shared/types'

export const DEFAULT_UPDATE_FEED_URL = 'https://everlook.ing/updates'

export type UpdateInfo = {
  version?: string
}

export type AutoUpdaterPort = {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  forceDevUpdateConfig: boolean
  setFeedURL: (options: { provider: 'generic'; url: string }) => void
  checkForUpdates: () => Promise<unknown>
  quitAndInstall: (isSilent?: boolean, isForceRunAfter?: boolean) => void
  // One overload per event AppUpdater listens to. Payloads stay unknown because
  // the handlers read them defensively; electron-updater's own event map is not
  // part of its public exports.
  on(event: 'checking-for-update', listener: () => void): unknown
  on(event: 'update-available', listener: (info: unknown) => void): unknown
  on(event: 'update-not-available', listener: (info: unknown) => void): unknown
  on(event: 'download-progress', listener: (progress: unknown) => void): unknown
  on(event: 'update-downloaded', listener: (info: unknown) => void): unknown
  on(event: 'error', listener: (error: unknown) => void): unknown
}

export function updateFeedUrl(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.EVERLOOK_UPDATE_URL?.trim()
  if (configured) return configured.replace(/\/$/, '')
  return DEFAULT_UPDATE_FEED_URL
}

export function updatesEnabled(packaged: boolean, env: NodeJS.ProcessEnv = process.env): boolean {
  return packaged || Boolean(env.EVERLOOK_UPDATE_URL?.trim())
}

export type DesktopUpdaterKind = 'automatic' | 'manual' | 'none'

export type DesktopUpdater = {
  getState(): UpdateState
  start(): void
  check(): Promise<void>
  install(): Promise<void>
  promptIfReady(): Promise<void>
  close(): void
}

/** Packaged macOS builds install from a download. That choice wins over an automatic feed. */
export function desktopUpdaterKind(input: {
  automaticUpdates: boolean
  packaged: boolean
  platform: string
}): DesktopUpdaterKind {
  if (input.packaged && input.platform === 'darwin') return 'manual'
  if (input.automaticUpdates) return 'automatic'
  return 'none'
}

export function canInstallUpdate(status: UpdateStatus, uploading: boolean): boolean {
  return status === 'ready' && !uploading
}

export function downloadPercentOf(payload: unknown): number | null {
  if (payload === null || typeof payload !== 'object') return null
  if (!('percent' in payload)) return null
  const percent = payload.percent
  if (typeof percent !== 'number' || !Number.isFinite(percent)) return null
  return Math.max(0, Math.min(100, Math.round(percent)))
}

export function formatUpdateError(error: unknown): string {
  const message = firstLine(messageOf(error))
  const haystack = `${codeOf(error)} ${statusCodeOf(error) ?? ''} ${message}`.toLowerCase()
  if (isMissingFeed(haystack)) {
    return prefix('The update feed was not found (404)', message)
  }
  if (isUnsigned(haystack)) {
    return prefix('The update could not be verified', message)
  }
  if (isNetwork(haystack)) {
    return prefix('Could not reach the update feed', message)
  }
  return message || 'Update failed.'
}

export class AppUpdater implements DesktopUpdater {
  private state: UpdateState
  private bound = false

  constructor(
    private readonly autoUpdater: AutoUpdaterPort,
    private readonly options: {
      currentVersion: string
      enabled: boolean
      forceDevUpdateConfig: boolean
      feedUrl: string
      isUploading: () => boolean
      onState: (state: UpdateState) => void
      promptToRestart: (version: string) => Promise<boolean>
    }
  ) {
    this.state = {
      status: options.enabled ? 'idle' : 'unavailable',
      currentVersion: options.currentVersion,
      availableVersion: null,
      downloadPercent: null,
      error: null
    }
  }

  getState(): UpdateState {
    return { ...this.state }
  }

  /** The feed updater stops with the process. Mac downloads abort in ManualUpdater. */
  close(): void {}

  start(): void {
    if (!this.options.enabled) {
      this.set({ status: 'unavailable', error: null, downloadPercent: null })
      return
    }
    this.configure()
    void this.check()
  }

  async check(): Promise<void> {
    if (!this.options.enabled) {
      this.set({ status: 'unavailable', error: null, downloadPercent: null })
      return
    }
    if (
      this.state.status === 'checking' ||
      this.state.status === 'downloading' ||
      this.state.status === 'ready'
    ) {
      return
    }
    this.configure()
    this.set({ status: 'checking', error: null, downloadPercent: null })
    try {
      await this.autoUpdater.checkForUpdates()
    } catch (error) {
      this.set({
        status: 'error',
        error: formatUpdateError(error),
        downloadPercent: null
      })
    }
  }

  async install(): Promise<void> {
    if (!canInstallUpdate(this.state.status, this.options.isUploading())) {
      throw new Error(
        this.options.isUploading()
          ? 'Wait for the current upload to finish before restarting.'
          : 'No downloaded update is ready.'
      )
    }
    this.autoUpdater.quitAndInstall(false, true)
  }

  async promptIfReady(): Promise<void> {
    if (!canInstallUpdate(this.state.status, this.options.isUploading())) return
    const version = this.state.availableVersion
    if (version === null) return
    if (await this.options.promptToRestart(version)) await this.install()
  }

  private configure(): void {
    this.autoUpdater.autoDownload = true
    this.autoUpdater.autoInstallOnAppQuit = true
    this.autoUpdater.forceDevUpdateConfig = this.options.forceDevUpdateConfig
    this.autoUpdater.setFeedURL({ provider: 'generic', url: this.options.feedUrl })
    this.bind()
  }

  private bind(): void {
    if (this.bound) return
    this.bound = true
    this.autoUpdater.on('checking-for-update', () => {
      this.set({ status: 'checking', error: null, downloadPercent: null })
    })
    this.autoUpdater.on('update-available', (info) => {
      this.set({
        status: 'available',
        availableVersion: versionOf(info),
        downloadPercent: null,
        error: null
      })
    })
    this.autoUpdater.on('update-not-available', () => {
      this.set({
        status: 'current',
        availableVersion: null,
        downloadPercent: null,
        error: null
      })
    })
    this.autoUpdater.on('download-progress', (progress) => {
      this.set({
        status: 'downloading',
        downloadPercent: downloadPercentOf(progress),
        error: null
      })
    })
    this.autoUpdater.on('update-downloaded', (info) => {
      this.set({
        status: 'ready',
        availableVersion: versionOf(info) ?? this.state.availableVersion,
        downloadPercent: 100,
        error: null
      })
      void this.promptIfReady()
    })
    this.autoUpdater.on('error', (error) => {
      this.set({
        status: 'error',
        error: formatUpdateError(error),
        downloadPercent: null
      })
    })
  }

  private set(update: Partial<UpdateState>): void {
    this.state = { ...this.state, ...update }
    this.options.onState(this.getState())
  }
}

function versionOf(info: unknown): string | null {
  if (info !== null && typeof info === 'object' && 'version' in info && typeof info.version === 'string') {
    return info.version
  }
  return null
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  if (
    error !== null &&
    typeof error === 'object' &&
    'message' in error &&
    typeof error.message === 'string'
  ) {
    return error.message
  }
  return ''
}

function firstLine(message: string): string {
  const line = message.split(/\r?\n/, 1)[0]
  return line === undefined ? message : line.trim()
}

function codeOf(error: unknown): string {
  if (error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
    return error.code
  }
  return ''
}

function statusCodeOf(error: unknown): number | null {
  if (
    error !== null &&
    typeof error === 'object' &&
    'statusCode' in error &&
    typeof error.statusCode === 'number'
  ) {
    return error.statusCode
  }
  return null
}

function prefix(label: string, message: string): string {
  if (message === '') return `${label}.`
  if (message.toLowerCase().includes(label.toLowerCase())) return message
  return `${label}: ${message}`
}

function isMissingFeed(haystack: string): boolean {
  return (
    haystack.includes('err_updater_channel_file_not_found') ||
    haystack.includes('cannot find channel') ||
    haystack.includes('404') ||
    haystack.includes(' 404')
  )
}

function isUnsigned(haystack: string): boolean {
  return (
    haystack.includes('err_updater_invalid_signature') ||
    haystack.includes('err_updater_no_checksum') ||
    haystack.includes('not signed') ||
    haystack.includes('signature') ||
    haystack.includes('unsigned') ||
    haystack.includes('checksum') ||
    haystack.includes('sha512')
  )
}

function isNetwork(haystack: string): boolean {
  return (
    haystack.includes('net::') ||
    haystack.includes('enotfound') ||
    haystack.includes('econnrefused') ||
    haystack.includes('econnreset') ||
    haystack.includes('etimedout') ||
    haystack.includes('err_internet') ||
    haystack.includes('err_name_not_resolved') ||
    haystack.includes('err_connection') ||
    haystack.includes('err_network') ||
    haystack.includes('err_failed') ||
    haystack.includes('internet') ||
    haystack.includes('offline')
  )
}
