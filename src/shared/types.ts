export type UploadStatus =
  | 'idle'
  | 'watching'
  | 'uploading'
  | 'uploaded'
  | 'unchanged'
  | 'error'

export type FileState = {
  path: string
  account: string
  lastDetectedAt: string | null
  lastUploadedAt: string | null
  lastUploadedHash: string | null
  status: UploadStatus
  error: string | null
  response: string | null
  /** Whether Everlook accepted the signature on the last upload. Null until it answers. */
  signed: 'signed' | 'unsigned' | null
}

export type WowLauncherSettings = {
  prefix: string
  battleNetLauncher: string
  proton: string
  gameId: string
  store: string
  inputWidth: number
  inputHeight: number
  outputWidth: number
  outputHeight: number
  scaler: string
  refreshRate: number | null
  fullscreen: boolean
  adaptiveSync: boolean
  realtime: boolean
  clearLdPreload: boolean
  gameMode: boolean
}

export type Settings = {
  baseUrl: string
  autoWatch: boolean
  closeToTray: boolean
  selectedFiles: string[]
  uploads: Record<string, { hash: string; uploadedAt: string }>
  wowLauncher: WowLauncherSettings
  /** The signer Everlook last issued to this account, kept to spot an out-of-date sign.lua. */
  accountSigner?: string | undefined
  desktopAccount?: { id: number; name: string; origin: string; tokenHash: string } | undefined
  installationRoots?: string[]
  startAtLogin?: boolean
  notifications?: { uploadFailures: boolean; updates: boolean }
  nativeBattleNetPath?: string | null
  uploadScopes?: Record<string, Record<string, { hash: string; uploadedAt: string }>>
  /** World files the user stopped watching. Discovery does not add them back. */
  ignoredFiles?: string[]
}

export type UpdateStatus =
  | 'idle'
  | 'unavailable'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'current'
  | 'error'

export type UpdateState = {
  mode?: 'automatic' | 'manual' | 'unsupported'
  downloadUrl?: string | null
  status: UpdateStatus
  currentVersion: string
  availableVersion: string | null
  downloadPercent: number | null
  error: string | null
}

export type AddonInstallStatus =
  | 'idle'
  | 'checking'
  | 'installing'
  | 'current'
  | 'behind'
  | 'missing'
  | 'git'
  | 'error'

export type AddonInstallState = {
  status: AddonInstallStatus
  addonsPath: string | null
  version: string | null
  publishedVersion: string | null
  title: string | null
  interface: string | null
  error: string | null
}

export type WowLauncherStatus = 'idle' | 'starting' | 'running' | 'stopping' | 'error'

export type WowLauncherState = {
  status: WowLauncherStatus
  scriptPath: string | null
  error: string | null
}

export type WowLaunchResult = {
  status: 'started' | 'already-running'
  scriptPath: string
}

export type SigningStatus =
  | 'unknown'
  | 'not_placed'
  | 'placed'
  | 'verified'
  | 'stale'
  | 'skipped'

export type SigningState = {
  status: SigningStatus
  /** First 8 characters of the signer for the token in sign.lua. */
  fingerprint: string | null
  placedPath: string | null
  error: string | null
}

export type SigningPlaceResult = { placed: number; skipped: number }

export type CredentialStorage = 'os-keyring' | 'user-file' | 'session'

export type PlatformCapabilities = {
  platform: string
  arch: string
  managedWowLauncher: boolean
  nativeBattleNet: boolean
  loginStartup: boolean
  automaticUpdates: boolean
}
export type DesktopAccount = { id: number; name: string }
export type PendingUpload = {
  path: string; scope: string; revision: string; force: boolean; queuedAt: string
  status: 'queued' | 'uploading' | 'retrying' | 'auth-required' | 'security-required' | 'contributions-revoked' | 'blocked'
  attempts: number; nextAttemptAt: string | null; error: string | null
  setupUrl: string | null
}
export type UploadHistoryEntry = {
  id: string; path: string; scope: string; at: string
  outcome: 'uploaded' | 'unchanged' | 'error'; hash: string | null; uploadId: number | null
  ingestStatus: string | null; signed: 'signed' | 'unsigned' | null; error: string | null
}
export type InstallationState = AddonInstallState & { signing: SigningState; files: string[] }
export type AppState = {
  capabilities?: PlatformCapabilities
  account?: DesktopAccount | null
  accountError?: string | null
  installations?: InstallationState[]
  pending?: PendingUpload[]
  history?: UploadHistoryEntry[]
  startup?: { supported: boolean; enabled: boolean; error: string | null }
  nativeLauncherPath?: string | null
  authenticated: boolean
  credentialStorage: CredentialStorage
  settings: Settings
  files: FileState[]
  update: UpdateState
  addon: AddonInstallState
  signing: SigningState
  wow: WowLauncherState
}

export type EverlookApi = {
  getState: () => Promise<AppState>
  chooseRoot: () => Promise<void>
  chooseFiles: () => Promise<void>
  removeFile: (path: string) => Promise<void>
  updateSettings: (
    settings: Pick<Settings, 'baseUrl' | 'autoWatch'> &
      Partial<Pick<Settings, 'wowLauncher' | 'closeToTray' | 'startAtLogin' | 'notifications'>>
  ) => Promise<void>
  login: () => Promise<void>
  logout: () => Promise<void>
  uploadFile: (path: string) => Promise<void>
  uploadAll: () => Promise<void>
  checkForUpdates: () => Promise<void>
  installUpdate: () => Promise<void>
  installAddon: (addonsPath?: string) => Promise<void>
  placeSigningToken: (addonsPath?: string) => Promise<SigningPlaceResult>
  refreshInstallations: () => Promise<void>
  chooseNativeLauncher: () => Promise<void>
  openNativeLauncher: () => Promise<void>
  retryFile: (path: string) => Promise<void>
  openSecuritySettings: (url: string) => Promise<void>
  exportDiagnostics: () => Promise<void>
  launchWow: () => Promise<WowLaunchResult>
  stopWow: () => Promise<void>
  onState: (listener: (state: AppState) => void) => () => void
  minimizeWindow: () => Promise<void>
  maximizeWindow: () => Promise<void>
  closeWindow: () => Promise<void>
  isWindowMaximized: () => Promise<boolean>
  onWindowMaximized: (listener: (maximized: boolean) => void) => () => void
}

/**
 * Each IPC channel and the EverlookApi method it backs. Preload and main both
 * type their side against it, so a handler has to resolve to exactly what
 * the renderer expects. A handler that forgets to return its result no
 * longer compiles.
 */
export type IpcMethods = {
  'installs:refresh': 'refreshInstallations'
  'launcher:choose': 'chooseNativeLauncher'
  'launcher:open': 'openNativeLauncher'
  'uploads:retry': 'retryFile'
  'security:open': 'openSecuritySettings'
  'diagnostics:export': 'exportDiagnostics'
  'state:get': 'getState'
  'files:choose-root': 'chooseRoot'
  'files:choose': 'chooseFiles'
  'files:remove': 'removeFile'
  'settings:update': 'updateSettings'
  'auth:login': 'login'
  'auth:logout': 'logout'
  'uploads:file': 'uploadFile'
  'uploads:all': 'uploadAll'
  'updates:check': 'checkForUpdates'
  'updates:install': 'installUpdate'
  'addon:install': 'installAddon'
  'addon:sign': 'placeSigningToken'
  'wow:launch': 'launchWow'
  'wow:stop': 'stopWow'
  'window:minimize': 'minimizeWindow'
  'window:maximize': 'maximizeWindow'
  'window:close': 'closeWindow'
  'window:is-maximized': 'isWindowMaximized'
}

export type IpcChannel = keyof IpcMethods

/** What a channel's handler resolves to: the return of the API method it backs. */
export type IpcResult<C extends IpcChannel> = Awaited<ReturnType<EverlookApi[IpcMethods[C]]>>
