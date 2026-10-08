import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import type { Settings, WowLauncherSettings } from '../shared/types'

export const DEFAULT_BASE_URL = 'https://everlook.ing'
// The address earlier installs saved. It no longer serves the site, so a
// saved setting that still holds it is rewritten to the default.
export const LEGACY_BASE_URL = 'https://everlook.csfh.dev'

const pathField = z.string().trim().min(1).max(4096)
const nameField = z.string().trim().min(1).max(128)
const pixelField = z.number().int().positive().max(32_000)

export const wowLauncherSettingsSchema = z.object({
  prefix: pathField,
  battleNetLauncher: pathField,
  proton: pathField,
  gameId: nameField,
  store: nameField,
  inputWidth: pixelField,
  inputHeight: pixelField,
  outputWidth: pixelField,
  outputHeight: pixelField,
  scaler: z.string().trim().min(1).max(32),
  refreshRate: z.number().int().positive().max(1000).nullable(),
  fullscreen: z.boolean(),
  adaptiveSync: z.boolean(),
  realtime: z.boolean(),
  clearLdPreload: z.boolean(),
  gameMode: z.boolean()
})

export function defaultWowLauncherSettings(homeDirectory = os.homedir()): WowLauncherSettings {
  const prefix = path.join(homeDirectory, 'Games', 'battlenet')
  return {
    prefix,
    battleNetLauncher: path.join(
      prefix,
      'drive_c',
      'Program Files (x86)',
      'Battle.net',
      'Battle.net Launcher.exe'
    ),
    proton: path.join(
      homeDirectory,
      '.steam',
      'steam',
      'compatibilitytools.d',
      'GE-Proton11-7-x86_64'
    ),
    gameId: 'umu-default',
    store: 'battlenet',
    inputWidth: 3008,
    inputHeight: 1692,
    outputWidth: 6016,
    outputHeight: 3384,
    scaler: 'integer',
    refreshRate: null,
    fullscreen: true,
    adaptiveSync: true,
    realtime: true,
    clearLdPreload: true,
    gameMode: true
  }
}

const settingsSchema = z.object({
  baseUrl: z.string().url(),
  autoWatch: z.boolean(),
  closeToTray: z.boolean().optional(),
  selectedFiles: z.array(z.string()),
  uploads: z.record(z.string(), z.object({ hash: z.string().length(64), uploadedAt: z.string() })),
  wowLauncher: wowLauncherSettingsSchema.optional(),
  desktopAccount: z.object({ id: z.number().int().positive(), name: z.string(), origin: z.string().url(), tokenHash: z.string().length(64) }).optional(),
  installationRoots: z.array(pathField).optional(),
  startAtLogin: z.boolean().optional(),
  notifications: z.object({ uploadFailures: z.boolean(), updates: z.boolean() }).optional(),
  nativeBattleNetPath: pathField.nullable().optional(),
  uploadScopes: z.record(z.string(), z.record(z.string(), z.object({ hash: z.string().length(64), uploadedAt: z.string() }))).optional(),
  accountSigner: z.string().regex(/^[0-9a-f]{16}$/).optional(),
  ignoredFiles: z.array(z.string()).optional()
})

function defaults(homeDirectory = os.homedir()): Settings {
  return {
    baseUrl: DEFAULT_BASE_URL,
    autoWatch: true,
    closeToTray: false,
    selectedFiles: [],
    uploads: {},
    installationRoots: [],
    startAtLogin: false,
    notifications: { uploadFailures: false, updates: false },
    nativeBattleNetPath: null,
    uploadScopes: {},
    ignoredFiles: [],
    wowLauncher: defaultWowLauncherSettings(homeDirectory)
  }
}

export function validateBaseUrl(value: string): string {
  const url = new URL(value)
  if (url.username !== '' || url.password !== '') {
    throw new Error('Everlook URL cannot contain credentials.')
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1'
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    throw new Error('Everlook URL must use HTTPS, except for localhost development.')
  }
  url.pathname = ''
  url.search = ''
  url.hash = ''
  return url.toString().replace(/\/$/, '')
}

export function publicBaseUrl(value: string): string {
  const validated = validateBaseUrl(value)
  if (validated === LEGACY_BASE_URL) {
    return DEFAULT_BASE_URL
  }
  return validated
}

export class SettingsStore {
  private persistence: Promise<void> = Promise.resolve()
  private settings: Settings
  private readonly filePath: string
  private readonly homeDirectory: string
  /** A failed read must not be saved over. An empty in-memory copy would erase the file. */
  private writesBlocked = false

  constructor(userDataPath: string, homeDirectory = os.homedir()) {
    this.filePath = path.join(userDataPath, 'settings.json')
    this.homeDirectory = homeDirectory
    this.settings = defaults(homeDirectory)
  }

  async load(): Promise<Settings> {
    let contents: string
    try {
      contents = await readFile(this.filePath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return this.get()
      return this.blockSavedSettings(error)
    }

    let parsed: z.infer<typeof settingsSchema>
    try {
      parsed = settingsSchema.parse(JSON.parse(contents))
    } catch (error) {
      return this.blockSavedSettings(error)
    }

    let baseUrl: string
    try {
      baseUrl = publicBaseUrl(parsed.baseUrl)
    } catch (error) {
      console.error('Saved Everlook URL is invalid; the default will be used.', error instanceof Error ? error.message : '')
      baseUrl = DEFAULT_BASE_URL
    }

    this.settings = {
      ...defaults(this.homeDirectory),
      installationRoots: parsed.installationRoots ?? [],
      startAtLogin: parsed.startAtLogin ?? false,
      notifications: parsed.notifications ?? { uploadFailures: false, updates: false },
      nativeBattleNetPath: parsed.nativeBattleNetPath ?? null,
      uploadScopes: parsed.uploadScopes ?? {},
      ignoredFiles: parsed.ignoredFiles ?? [],
      ...(parsed.desktopAccount ? { desktopAccount: parsed.desktopAccount } : {}),
      baseUrl,
      autoWatch: parsed.autoWatch,
      closeToTray: parsed.closeToTray ?? false,
      selectedFiles: parsed.selectedFiles,
      uploads: parsed.uploads,
      wowLauncher: parsed.wowLauncher ?? defaultWowLauncherSettings(this.homeDirectory),
      ...(parsed.accountSigner === undefined ? {} : { accountSigner: parsed.accountSigner })
    }
    if (baseUrl !== parsed.baseUrl || parsed.wowLauncher === undefined) {
      await this.persist()
    }
    return this.get()
  }

  private blockSavedSettings(error: unknown): never {
    this.writesBlocked = true
    console.error('Could not read Everlook settings.', error instanceof Error ? error.name : 'UnknownError')
    throw new Error('Could not read the saved desktop state.')
  }

  get(): Settings {
    return structuredClone(this.settings)
  }

  async update(update: Partial<Settings>): Promise<Settings> {
    const merged = {
      ...this.settings,
      ...update,
      baseUrl: update.baseUrl ? publicBaseUrl(update.baseUrl) : this.settings.baseUrl,
      wowLauncher: update.wowLauncher ?? this.settings.wowLauncher
    }
    this.settings = {
      ...merged,
      wowLauncher: wowLauncherSettingsSchema.parse(merged.wowLauncher)
    }
    await this.persist()
    return this.get()
  }

  private persist(): Promise<void> {
    const snapshot = JSON.stringify(this.settings, null, 2)
    const operation = this.persistence.catch(() => undefined).then(() => this.persistSnapshot(snapshot))
    this.persistence = operation
    return operation
  }

  private async persistSnapshot(snapshot: string): Promise<void> {
    if (this.writesBlocked) {
      throw new Error('Everlook settings could not be read, so they were not replaced.')
    }
    await mkdir(path.dirname(this.filePath), { recursive: true })
    const temporaryPath = `${this.filePath}.tmp`
    await writeFile(temporaryPath, snapshot, { mode: 0o600 })
    await rename(temporaryPath, this.filePath)
  }
}
