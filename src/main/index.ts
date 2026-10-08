import os from 'node:os'
import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  nativeTheme,
  Notification,
  safeStorage,
  session,
  shell
} from 'electron'
import { z } from 'zod'
import { loadAutoUpdater } from './auto-updater'
import { AuthSession, CUSTOM_SCHEME_REDIRECT_URI, LINUX_WM_CLASS, PROTOCOL_SCHEME } from './auth-session'
import { startAuthCallbackServer } from './auth-callback-server'
import { discoverWorldFiles, discoverFromRoot, isForeverInstall, FOREVER_FLAVOR_DIRECTORIES } from './discovery'
import { additionsToWatch, canonicalSelectedWorldFile, stopWatching, watchFiles } from './watched-files'
import { projectFileStates, type FileRuntime } from './file-states'
import { AddonManager, idleAddonState } from './addon-manager'
import { idleSigningState } from './signing-status'
import { nextIngestPolls } from './ingest-polls'
import { isTrustedIpcSender } from './ipc-trust'
import { waitForIngest } from './upload-status'
import { SettingsStore, wowLauncherSettingsSchema } from './settings'
import {
  createSafeStorageCipher,
  enableLinuxPlainTextEncryption,
  probeSafeStorage,
  resolveCredentialStorage,
  TokenStore
} from './token-store'
import { AppUpdater, desktopUpdaterKind, updateFeedUrl, type DesktopUpdater } from './updater'
import { ManualUpdater } from './manual-updater'
import { boundedRequest } from './request'
import { fetchDesktopIdentity, DesktopIdentityError, SECURITY_HOLD_POLL_MS, shouldReleaseSecurityHold } from './desktop-identity'
import { UploadRecoveryService, uploadScope } from './upload-recovery'
import { getPlatformCapabilities } from './platform'
import { discoverNativeLauncher, validateNativeLauncher, launchNativeBattleNet } from './native-launcher'
import { configureStartup, readStartup, type StartupState } from './startup'
import { buildDiagnostics } from './diagnostics'
import { createNotifications, updateNotification } from './notifications'
import { createTray, type EverlookTray } from './tray'
import { describeUpload, UploadCoordinator, uploadOutcome } from './uploader'
import { WorldFileWatcher } from './watcher'
import { ensureWowLauncher, idleWowLauncherState, WowLauncher } from './wow-launcher'
import type {
  AppState,
  DesktopAccount,
  IpcChannel,
  IpcResult,
  UpdateState
} from '../shared/types'

const smokeTest = app.isPackaged && (process.argv.includes('--smoke-test') || process.argv.includes('--update-smoke-test'))
if (smokeTest && process.env.EVERLOOK_SMOKE_USER_DATA) app.setPath('userData', process.env.EVERLOOK_SMOKE_USER_DATA)
const autoUpdater = loadAutoUpdater()
const capabilities = getPlatformCapabilities({ packaged: app.isPackaged })
const notifications = createNotifications({ isSupported: () => Notification.isSupported(), show: (options) => new Notification(options).show() })
let account: DesktopAccount | null = null
let accountError: string | null = null
let sessionController = new AbortController()
let identityTimer: NodeJS.Timeout | null = null
let securityPoll: NodeJS.Timeout | null = null
let recovery: UploadRecoveryService | undefined
const ingestPolling = new Map<string, Promise<void>>()
let startup: StartupState = { supported: false, enabled: false, error: null }
let nativeLauncherPath: string | null = null
function context(): { origin: string; accountId: number } | null {
  return account === null ? null : { origin: settingsStore.get().baseUrl, accountId: account.id }
}
function currentUploads(): Record<string, { hash: string; uploadedAt: string }> {
  const current = context()
  return current === null ? {} : settingsStore.get().uploadScopes?.[uploadScope(current)] ?? {}
}
function startupOptions() {
  return {
    platform: process.platform, packaged: app.isPackaged, executable: process.env.APPIMAGE ?? process.execPath,
    homeDirectory: os.homedir(), ...(process.env.XDG_CONFIG_HOME ? { configDirectory: process.env.XDG_CONFIG_HOME } : {}),
    setLoginItemSettings: (settings: Electron.Settings) => app.setLoginItemSettings(settings),
    getLoginItemSettings: (options?: Electron.LoginItemSettingsOptions) => app.getLoginItemSettings(options)
  }
}
function suspendSession(): void {
  recovery?.pause()
  ingestPolling.clear()
  sessionController.abort()
  sessionController = new AbortController()
  if (identityTimer) clearTimeout(identityTimer)
  identityTimer = null
  if (securityPoll) clearTimeout(securityPoll)
  securityPoll = null
}
function securityHoldActive(): boolean {
  return recovery?.getState().pending.some((entry) => entry.status === 'security-required') ?? false
}
function armSecurityPoll(): void {
  if (securityPoll !== null || !securityHoldActive()) return
  securityPoll = setTimeout(() => {
    securityPoll = null
    void verifyAccount().then(publishState).catch(reportBackgroundError)
  }, SECURITY_HOLD_POLL_MS)
  securityPoll.unref()
}
async function verifyAccount(): Promise<void> {
  const signal = sessionController.signal
  const origin = settingsStore.get().baseUrl
  try {
    const identity = await fetchDesktopIdentity({ origin, token: () => tokenStore.get(), signal })
    if (signal.aborted) return
    if (identity === null) { account = null; return }
    if (account?.id !== identity.id) { recovery?.pause(); runtime.clear() }
    account = { id: identity.id, name: identity.name }
    accountError = null
    await settingsStore.update({
      desktopAccount: { id: identity.id, name: identity.name, tokenHash: identity.tokenHash, origin }
    })
    if (signal.aborted) return
    await queueCurrentFiles(signal)
    if (signal.aborted) return
    if (shouldReleaseSecurityHold(identity)) {
      if (securityPoll) clearTimeout(securityPoll)
      securityPoll = null
      await recovery?.releaseSecurity()
    } else {
      armSecurityPoll()
    }
    if (signal.aborted) return
    void recovery?.resume().catch(reportBackgroundError)
  } catch (error) {
    if (signal.aborted) return
    if (error instanceof DesktopIdentityError && [401, 403].includes(error.httpStatus)) {
      recovery?.pause()
      accountError = 'Sign in again to resume uploads.'
      return
    }
    accountError = 'Everlook is offline. Your pending uploads will resume when it is reachable.'
    identityTimer = setTimeout(() => void verifyAccount().then(publishState).catch(reportBackgroundError), 30_000)
    identityTimer.unref()
  }
}
function reportBackgroundError(error: unknown): void { console.error('Everlook background task failed:', error instanceof Error ? error.name : 'UnknownError') }
function notifyUpdate(): void {
  const event = updateNotification(appUpdater?.getState())
  if (event === null) return
  notifications.notify(event, settingsStore.get().notifications ?? { uploadFailures: false, updates: false })
}

app.enableSandbox()
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('class', LINUX_WM_CLASS)
  enableLinuxPlainTextEncryption(safeStorage)
}

const authSession = new AuthSession()
const runtime = new Map<string, FileRuntime>()
let mainWindow: BrowserWindow | null = null
let tray: EverlookTray | null = null
let quitting = false
let shutdownComplete = false
let settingsStore: SettingsStore
let tokenStore: TokenStore
let uploader: UploadCoordinator
let watcher: WorldFileWatcher
let appUpdater: DesktopUpdater | undefined
let addons: AddonManager
let wowLauncher: WowLauncher | undefined
let readyForProtocol = false
const pendingProtocolUrls = new Set<string>()

const addonTarget = z.object({ addonsPath: z.string().min(1).max(4096).optional() })
const pathPayload = z.object({ path: z.string().min(1).max(4096) })
const settingsPayload = z.object({
  baseUrl: z.string().url(),
  autoWatch: z.boolean(),
  closeToTray: z.boolean().optional(),
  wowLauncher: wowLauncherSettingsSchema.optional(),
  startAtLogin: z.boolean().optional(),
  notifications: z.object({ uploadFailures: z.boolean(), updates: z.boolean() }).optional()
})
const tokenResponse = z.object({
  access_token: z.string().regex(/^[a-fA-F0-9]{64}$/),
  token_type: z.literal('Bearer')
})

function registerHandler<C extends IpcChannel>(
  channel: C,
  handler: (payload: unknown) => Promise<IpcResult<C>>
): void {
  ipcMain.handle(channel, async (event, payload) => {
    // A frame that navigated away or was destroyed has no URL to trust.
    const frame = event.senderFrame
    if (frame === null || !isTrustedIpcSender(frame.url, { packaged: app.isPackaged, rendererUrl: process.env.ELECTRON_RENDERER_URL })) {
      throw new Error('Untrusted IPC sender.')
    }
    return handler(payload)
  })
}

async function state(): Promise<AppState> {
  if (wowLauncher !== undefined) {
    await wowLauncher.refresh()
  }
  const settings = settingsStore.get()
  const token = await tokenStore.get()
  const recovered = recovery?.getState() ?? { pending: [], history: [] }
  return {
    capabilities, account, accountError, installations: addons.installations, startup, nativeLauncherPath,
    ...recovered,
    authenticated: token !== null,
    credentialStorage: tokenStore.credentialStorage(),
    settings,
    files: projectFileStates({
      selectedFiles: settings.selectedFiles,
      uploads: currentUploads(),
      runtime,
      history: recovered.history,
      autoWatch: settings.autoWatch
    }),
    update: appUpdater?.getState() ?? idleUpdateState(),
    addon: { ...addons.addon },
    signing: { ...addons.signing },
    wow: wowLauncher?.getState() ?? idleWowLauncherState()
  }
}

function idleUpdateState(): UpdateState {
  return {
    status: 'unavailable',
    mode: 'unsupported',
    currentVersion: app.getVersion(),
    availableVersion: null,
    downloadPercent: null,
    error: null
  }
}

async function publishState(): Promise<void> {
  const next = await state()
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('state:changed', next)
  }
  tray?.update(next)
}

function showWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow()
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

async function uploadAll(): Promise<void> {
  await Promise.all(settingsStore.get().selectedFiles.map((filePath) => upload(filePath)))
  await appUpdater?.promptIfReady()
}

async function toggleWow(): Promise<void> {
  if (capabilities.nativeBattleNet) { await openNativeLauncher(); return }
  if (wowLauncher === undefined) return
  if (wowLauncher.getState().status === 'running') await wowLauncher.stop()
  else await wowLauncher.start()
  await publishState()
}

function startTray(): void {
  try {
    tray = createTray({
      uploadAll: () => void uploadAll().catch((error: unknown) => console.error(error)),
      toggleWow: () => void toggleWow().catch((error: unknown) => console.error(error)),
      open: showWindow,
      quit: () => app.quit()
    })
  } catch (error) {
    console.error('Could not create the tray icon.', error)
    tray = null
  }
}

function publishMaximized(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('window:maximized', mainWindow.isMaximized())
  }
}

async function upload(filePath: string, detected = false): Promise<void> {
  const selected = canonicalSelectedWorldFile(filePath, settingsStore.get().selectedFiles)
  if (selected === null) return
  if (!recovery || !account) throw new Error('Sign in to Everlook to upload files.')
  if (detected) runtime.set(selected, { ...runtime.get(selected), lastDetectedAt: new Date().toISOString() })
  await recovery.enqueue(selected, !detected)
}
async function performUpload(filePath: string, force: boolean, signal: AbortSignal) {
  runtime.set(filePath, { ...runtime.get(filePath), status: 'uploading', error: null, response: null })
  await publishState()
  try {
    const result = await uploader.upload(filePath, { force, signal })
    signal.throwIfAborted()
    runtime.set(filePath, {
      ...runtime.get(filePath), status: uploadOutcome(result), error: null,
      response: describeUpload(result), ...(result.unchanged ? {} : { signed: null })
    })
    return result
  } catch (error) {
    if (!signal.aborted) runtime.set(filePath, { ...runtime.get(filePath), status: 'error', error: 'Upload could not finish. See pending uploads for retry details.', response: null })
    throw error
  } finally { await publishState() }
}

function resumeIngestPolling(): void {
  if (account === null || accountError !== null) return
  const current = context()
  if (current === null) return
  for (const poll of nextIngestPolls({
    history: recovery?.getState().history ?? [],
    scope: uploadScope(current),
    inFlight: new Set(ingestPolling.keys())
  })) {
    const task = checkSignature(poll.path, poll.hash).catch(reportBackgroundError).finally(() => {
      if (ingestPolling.get(poll.key) === task) ingestPolling.delete(poll.key)
    })
    ingestPolling.set(poll.key, task)
  }
}

async function checkSignature(filePath: string, hash: string): Promise<void> {
  const signal = sessionController.signal
  const origin = settingsStore.get().baseUrl
  const token = await tokenStore.get()
  if (signal.aborted || token === null || account === null) return
  await waitForIngest({
    baseUrl: origin, token, sha256: hash, signal,
    onStatus: async (verdict) => {
      if (signal.aborted) return
      await recovery?.updateIngest(hash, verdict)
      if (signal.aborted || currentUploads()[filePath]?.hash !== hash) return
      runtime.set(filePath, { ...runtime.get(filePath), signed: verdict.signed })
      if (verdict.status === 'failed' || verdict.status === 'rejected') notifications.notify({ kind: 'upload-failed', id: `ingest:${verdict.id}` }, settingsStore.get().notifications ?? { uploadFailures: false, updates: false })
      await publishState()
    }
  })
  await addons.applyCatalogSigning().catch(() => undefined)
}

async function restartWatcher(): Promise<void> {
  const settings = settingsStore.get()
  await watcher.watch(settings.selectedFiles, settings.autoWatch)
}

async function addFiles(files: string[]): Promise<void> {
  const settings = settingsStore.get()
  await settingsStore.update(watchFiles(settings.selectedFiles, settings.ignoredFiles ?? [], files))
  await restartWatcher()
  await publishState()
  void addons.refresh()
}

async function openNativeLauncher(): Promise<void> {
  if (!capabilities.nativeBattleNet || !nativeLauncherPath) throw new Error('Choose the Battle.net launcher first.')
  await launchNativeBattleNet({ platform: process.platform, path: nativeLauncherPath, openPath: (file) => shell.openPath(file) })
}
async function queueCurrentFiles(signal = sessionController.signal): Promise<void> {
  if (!account || !settingsStore.get().autoWatch) return
  for (const file of settingsStore.get().selectedFiles) {
    if (signal.aborted) return
    if (!recovery?.getState().pending.some((item) => item.path === file)) await recovery?.enqueue(file)
  }
}
async function rescanFiles(): Promise<void> {
  const settings = settingsStore.get()
  const discovered = (await Promise.all((await addons.installationRoots()).map(discoverFromRoot))).flat()
  const additions = additionsToWatch(discovered, settings.selectedFiles, settings.ignoredFiles ?? [])
  if (additions.length === 0) return
  await addFiles(additions)
  if (account && settings.autoWatch) {
    for (const file of additions) {
      if (canonicalSelectedWorldFile(file, settingsStore.get().selectedFiles) === null) continue
      await recovery?.enqueue(file)
    }
  }
}

async function completeAuthorization(rawUrl: string): Promise<void> {
  const signal = sessionController.signal
  const origin = settingsStore.get().baseUrl
  const { code, verifier, redirectUri } = authSession.consume(rawUrl)
  const response = await boundedRequest(fetch, `${origin}/api/desktop/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri
    })
  }, { signal })
  signal.throwIfAborted()
  if (!response.ok) throw new Error(`Everlook rejected authorization (${response.status}).`)
  const credential = tokenResponse.parse(await response.json())
  signal.throwIfAborted()
  suspendSession()
  const completionSignal = sessionController.signal
  account = null
  runtime.clear()
  await settingsStore.update({ accountSigner: undefined, desktopAccount: undefined })
  completionSignal.throwIfAborted()
  await tokenStore.set(credential.access_token)
  completionSignal.throwIfAborted()
  await verifyAccount()
  completionSignal.throwIfAborted()
  await publishState()
  showWindow()
}

async function handleProtocolUrl(rawUrl: string): Promise<void> {
  try {
    await completeAuthorization(rawUrl)
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') return
    dialog.showErrorBox(
      'Everlook could not sign in',
      error instanceof Error ? error.message : 'Unexpected authorization error.'
    )
  }
}

function receiveProtocolUrl(rawUrl: string): void {
  if (readyForProtocol) {
    void handleProtocolUrl(rawUrl)
  } else {
    pendingProtocolUrls.add(rawUrl)
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    icon: app.isPackaged
      ? path.join(process.resourcesPath, 'icon.png')
      : path.join(app.getAppPath(), 'build/icon-512.png'),
    width: 1040,
    height: 720,
    minWidth: 720,
    minHeight: 560,
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0a0a0a' : '#ffffff',
    frame: process.platform === 'darwin',
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' as const } : {}),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false
    }
  })

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  mainWindow.webContents.on('will-navigate', (event, destination) => {
    if (destination !== mainWindow?.webContents.getURL()) event.preventDefault()
  })
  mainWindow.once('ready-to-show', () => { if (!process.argv.includes('--background') && !(process.platform === 'darwin' && app.getLoginItemSettings().wasOpenedAtLogin)) mainWindow?.show() })
  mainWindow.on('close', (event) => {
    if (quitting || tray === null || !settingsStore.get().closeToTray) return
    event.preventDefault()
    mainWindow?.hide()
  })
  mainWindow.on('maximize', publishMaximized)
  mainWindow.on('unmaximize', publishMaximized)
  mainWindow.on('focus', () => {
    if (!securityHoldActive()) return
    void verifyAccount().then(publishState).catch(reportBackgroundError)
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

function registerIpc(): void {
  registerHandler('installs:refresh', async () => { await rescanFiles(); await addons.refresh() })
  registerHandler('uploads:retry', async (payload) => {
    const { path: filePath } = pathPayload.parse(payload)
    if (!settingsStore.get().selectedFiles.includes(filePath)) throw new Error('This file is not configured.')
    await recovery?.retry(filePath)
  })
  registerHandler('security:open', async (payload) => {
    const { url } = z.object({ url: z.string().url() }).parse(payload)
    const target = new URL(url)
    if (target.protocol !== 'https:' && target.protocol !== 'http:') {
      throw new Error('Security settings must be a web address.')
    }
    await shell.openExternal(target.toString())
  })
  registerHandler('launcher:choose', async () => {
    if (!capabilities.nativeBattleNet) throw new Error('Native Battle.net is unavailable on this platform.')
    const result = await dialog.showOpenDialog({ properties: ['openFile'], ...(process.platform === 'win32' ? { filters: [{ name: 'Battle.net', extensions: ['exe'] }] } : {}) })
    if (result.canceled || !result.filePaths[0]) return
    await validateNativeLauncher({ platform: process.platform, path: result.filePaths[0] })
    nativeLauncherPath = result.filePaths[0]
    await settingsStore.update({ nativeBattleNetPath: nativeLauncherPath })
    await publishState()
  })
  registerHandler('launcher:open', openNativeLauncher)
  registerHandler('diagnostics:export', async () => {
    const destination = await dialog.showSaveDialog({ defaultPath: 'Everlook-diagnostics.json', filters: [{ name: 'JSON', extensions: ['json'] }] })
    if (destination.canceled || !destination.filePath) return
    const snapshot = await state()
    const diagnostics = buildDiagnostics({
      app: { version: app.getVersion(), packaged: app.isPackaged, electronVersion: process.versions.electron }, platform: capabilities,
      credentialStorage: snapshot.credentialStorage, homeDirectory: os.homedir(), baseUrl: snapshot.settings.baseUrl,
      installs: addons.installations.filter((item) => item.addonsPath !== null).map((item) => ({ path: item.addonsPath!, version: item.version, status: item.status, signing: item.signing.status, error: item.error })),
      files: snapshot.files, uploads: { pending: snapshot.pending?.length ?? 0, history: snapshot.history?.length ?? 0 }, errors: [{ source: 'startup', error: startup.error }, { source: 'update', error: snapshot.update.error }],
      session: {
        authenticated: snapshot.authenticated,
        autoWatch: snapshot.settings.autoWatch,
        accountError: snapshot.accountError,
        startup: { supported: startup.supported, enabled: startup.enabled, error: startup.error },
        update: {
          status: snapshot.update.status,
          ...(snapshot.update.mode !== undefined ? { mode: snapshot.update.mode } : {}),
          error: snapshot.update.error
        },
        launcher: { status: snapshot.wow.status, error: snapshot.wow.error },
        pending: (snapshot.pending ?? []).map((entry) => ({ status: entry.status }))
      }
    })
    await writeFile(destination.filePath, JSON.stringify(diagnostics, null, 2), { mode: 0o600 })
  })
  registerHandler('state:get', async () => state())
  registerHandler('files:choose-root', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    if (!result.canceled && result.filePaths[0]) {
      const selected = result.filePaths[0]
      const root = FOREVER_FLAVOR_DIRECTORIES.some((flavor) => path.basename(selected) === flavor) ? path.dirname(selected) : selected
      if (!(await isForeverInstall(root))) throw new Error('Select the World of Warcraft folder containing a Forever installation.')
      await settingsStore.update({ installationRoots: [...new Set([...(settingsStore.get().installationRoots ?? []), root])] })
      await addFiles(await discoverFromRoot(root))
      await addons.refresh()
    }
  })
  registerHandler('files:choose', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Everlook world data', extensions: ['lua'] }]
    })
    if (!result.canceled) {
      const discovered = await Promise.all(result.filePaths.map(discoverFromRoot))
      await addFiles(discovered.flat())
    }
  })
  registerHandler('files:remove', async (payload) => {
    const { path: filePath } = pathPayload.parse(payload)
    const settings = settingsStore.get()
    const uploads = { ...settings.uploads }
    delete uploads[filePath]
    await settingsStore.update({
      ...stopWatching(settings.selectedFiles, settings.ignoredFiles ?? [], filePath),
      uploads
    })
    await recovery?.remove(filePath)
    runtime.delete(filePath)
    await restartWatcher()
    await publishState()
  })
  registerHandler('settings:update', async (payload) => {
    const { closeToTray, wowLauncher, startAtLogin, notifications: notificationPreferences, ...required } = settingsPayload.parse(payload)
    const settings = settingsStore.get()
    if (required.baseUrl !== settings.baseUrl && (await tokenStore.get()) !== null) {
      throw new Error('Log out before changing the Everlook URL.')
    }
    // Leave out settings the page didn't send, so they keep their saved value.
    await settingsStore.update({
      ...required,
      ...(closeToTray === undefined ? {} : { closeToTray }),
      ...(wowLauncher === undefined ? {} : { wowLauncher }),
      ...(startAtLogin === undefined ? {} : { startAtLogin }),
      ...(notificationPreferences === undefined ? {} : { notifications: notificationPreferences })
    })
    if (startAtLogin !== undefined) startup = await configureStartup({ ...startupOptions(), enabled: startAtLogin })
    if (wowLauncher !== undefined && capabilities.managedWowLauncher) {
      await ensureWowLauncher(os.homedir(), wowLauncher)
    }
    await restartWatcher()
    await publishState()
    void addons.refresh()
  })
  registerHandler('auth:login', async () => {
    suspendSession()
    const signal = sessionController.signal
    const baseUrl = settingsStore.get().baseUrl
    const expectedOrigin = new URL(baseUrl).origin
    const callbackServer = await startAuthCallbackServer().catch(() => null)
    let awaitingProtocol = false
    let authorized = false
    try {
      signal.throwIfAborted()
      const redirectUri = callbackServer?.redirectUri ?? CUSTOM_SCHEME_REDIRECT_URI
      const authorization = authSession.begin(baseUrl, redirectUri)
      if (new URL(authorization.url).origin !== expectedOrigin) {
        throw new Error('Unexpected authorization origin.')
      }
      await shell.openExternal(authorization.url)
      if (callbackServer === null) { awaitingProtocol = true; return }
      const callback = await callbackServer.waitForCallback(5 * 60_000)
      signal.throwIfAborted()
      await completeAuthorization(callback)
      authorized = true
    } finally {
      await callbackServer?.close()
      if (!authorized && !awaitingProtocol && !signal.aborted && account !== null) {
        void verifyAccount().then(publishState).catch(reportBackgroundError)
      }
    }
  })
  registerHandler('auth:logout', async () => {
    suspendSession()
    authSession.clear()
    const signal = sessionController.signal
    const origin = settingsStore.get().baseUrl
    const token = await tokenStore.get()
    if (signal.aborted) return
    account = null
    accountError = null
    runtime.clear()
    await tokenStore.clear()
    if (signal.aborted) return
    await settingsStore.update({ accountSigner: undefined, desktopAccount: undefined })
    if (signal.aborted) return
    await publishState()
    if (token !== null) {
      // Local sign-out still completes when the server cannot be reached.
      await boundedRequest(fetch, `${origin}/api/desktop/token`, {
        method: 'DELETE', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }
      }, { timeoutMs: 10_000, signal }).catch(() => undefined)
    }
  })
  registerHandler('uploads:file', async (payload) => {
    const { path: filePath } = pathPayload.parse(payload)
    if (!settingsStore.get().selectedFiles.includes(filePath)) {
      throw new Error('The selected file is not configured.')
    }
    await upload(filePath)
    await appUpdater?.promptIfReady()
  })
  registerHandler('uploads:all', uploadAll)
  registerHandler('updates:check', async () => {
    await appUpdater?.check()
  })
  registerHandler('updates:install', async () => {
    await appUpdater?.install()
  })
  registerHandler('addon:install', async (payload) => { await addons.install(addonTarget.parse(payload ?? {}).addonsPath) })
  registerHandler('addon:sign', async (payload) => addons.placeSigningToken(addonTarget.parse(payload ?? {}).addonsPath))
  registerHandler('wow:launch', async () => {
    if (wowLauncher === undefined) {
      throw new Error('The WoW launcher is not ready.')
    }
    const result = await wowLauncher.start()
    await publishState()
    return result
  })
  registerHandler('wow:stop', async () => {
    if (wowLauncher === undefined) {
      throw new Error('The WoW launcher is not ready.')
    }
    await wowLauncher.stop()
    await publishState()
  })
  registerHandler('window:minimize', async () => {
    mainWindow?.minimize()
  })
  registerHandler('window:maximize', async () => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (mainWindow.isMaximized()) mainWindow.unmaximize()
    else mainWindow.maximize()
  })
  registerHandler('window:close', async () => {
    mainWindow?.close()
  })
  registerHandler('window:is-maximized', async () => mainWindow?.isMaximized() ?? false)
}

async function runUpdateSmokeTest(): Promise<void> {
  try {
    if (process.platform !== 'win32') throw new Error('Update smoke requires Windows')
    const feed = new URL(process.env.EVERLOOK_SMOKE_FEED ?? '')
    if (feed.protocol !== 'http:' || feed.hostname !== '127.0.0.1' || feed.username || feed.password) throw new Error('Update smoke requires a loopback feed')
    const timeout = setTimeout(() => app.exit(1), 180_000)
    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = false
    autoUpdater.setFeedURL({ provider: 'generic', url: feed.origin })
    autoUpdater.on('error', () => { clearTimeout(timeout); app.exit(1) })
    autoUpdater.on('update-downloaded', () => {
      clearTimeout(timeout)
      process.stdout.write('EVERLOOK_UPDATE_SMOKE_OK\n')
      autoUpdater.quitAndInstall(true, false)
    })
    await autoUpdater.checkForUpdates()
  } catch { app.exit(1) }
}

async function runSmokeTest(): Promise<void> {
  const window = new BrowserWindow({ show: false, webPreferences: { preload: path.join(__dirname, '../preload/index.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false } })
  const timeout = setTimeout(() => app.exit(1), 20_000)
  try {
    // Exercise the packaged renderer and real sandboxed preload with no credentials or background services.
    ipcMain.handle('state:get', () => ({
      authenticated: false, credentialStorage: 'session',
      settings: { baseUrl: 'https://everlook.csfh.dev', autoWatch: true, closeToTray: false, selectedFiles: [], uploads: {}, wowLauncher: {} },
      files: [], update: idleUpdateState(), addon: idleAddonState(), signing: idleSigningState(), wow: idleWowLauncherState(), capabilities
    }))
    ipcMain.handle('window:is-maximized', () => false)
    await window.loadFile(path.join(__dirname, '../renderer/index.html'))
    const valid = await window.webContents.executeJavaScript(`(async () => { await new Promise(resolve => setTimeout(resolve, 250)); return Boolean(window.everlook && typeof window.everlook.getState === 'function' && document.getElementById('root')?.childElementCount > 0) })()`)
    if (!valid) throw new Error('Packaged preload failed')
    const smokeState = await window.webContents.executeJavaScript('window.everlook.getState()')
    if (smokeState.authenticated !== false) throw new Error('Packaged IPC failed')
    process.stdout.write(`EVERLOOK_SMOKE_VERSION=${app.getVersion()}\n`)
    process.stdout.write('EVERLOOK_SMOKE_OK\n')
    clearTimeout(timeout)
    app.exit(0)
  } catch { clearTimeout(timeout); app.exit(1) }
}

function protocolUrlFromArguments(argumentsList: string[]): string | undefined {
  return argumentsList.find((argument) => argument.startsWith(`${PROTOCOL_SCHEME}://`))
}

const hasInstanceLock = app.requestSingleInstanceLock()
if (!hasInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', (_event, commandLine) => {
    const protocolUrl = protocolUrlFromArguments(commandLine)
    if (protocolUrl) receiveProtocolUrl(protocolUrl)
    if (readyForProtocol) showWindow()
  })
  app.on('open-url', (event, url) => {
    event.preventDefault()
    receiveProtocolUrl(url)
  })

  void app.whenReady().then(async () => {
    if (smokeTest) {
      // Only the Windows update smoke asks for this, on a disposable runner, to prove an updated install can register the scheme.
      if (process.env.EVERLOOK_SMOKE_REGISTER_PROTOCOL === '1') app.setAsDefaultProtocolClient(PROTOCOL_SCHEME)
      if (process.argv.includes('--update-smoke-test')) await runUpdateSmokeTest()
      else await runSmokeTest()
      return
    }
    if (app.isPackaged) {
      app.setAsDefaultProtocolClient(PROTOCOL_SCHEME)
    } else if (process.argv[1]) {
      app.setAsDefaultProtocolClient(PROTOCOL_SCHEME, process.execPath, [path.resolve(process.argv[1])])
    }

    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
      callback(false)
    })
    settingsStore = new SettingsStore(app.getPath('userData'))
    const encryptionAvailable = await probeSafeStorage(safeStorage)
    tokenStore = new TokenStore(app.getPath('userData'), {
      cipher: encryptionAvailable ? createSafeStorageCipher(safeStorage) : null,
      credentialStorage: resolveCredentialStorage(
        process.platform === 'linux'
          ? {
            platform: process.platform,
            encryptionAvailable,
            linuxBackend: safeStorage.getSelectedStorageBackend()
          }
          : { platform: process.platform, encryptionAvailable }
      )
    })
    await settingsStore.load()
    addons = new AddonManager({
      settings: settingsStore,
      token: () => tokenStore.get(),
      signal: () => sessionController.signal,
      userDataDirectory: () => app.getPath('userData'),
      publish: publishState
    })
    const loaded = settingsStore.get()
    if (loaded.selectedFiles.length === 0) {
      const selectedFiles = additionsToWatch(await discoverWorldFiles(), [], loaded.ignoredFiles ?? [])
      if (selectedFiles.length > 0) await settingsStore.update({ selectedFiles })
    }
    uploader = new UploadCoordinator({
      previousHash: (filePath) => currentUploads()[filePath]?.hash ?? null,
      token: () => tokenStore.get(),
      baseUrl: () => settingsStore.get().baseUrl,
      saved: async (filePath, hash, uploadedAt) => {
        const settings = settingsStore.get()
        const current = context()
        if (current === null) return
        const scope = uploadScope(current)
        await settingsStore.update({ uploadScopes: { ...settings.uploadScopes, [scope]: { ...currentUploads(), [filePath]: { hash, uploadedAt } } } })
      }
    })
    recovery = new UploadRecoveryService({
      directory: app.getPath('userData'), context, upload: performUpload,
      onChange: () => {
        resumeIngestPolling()
        for (const pending of recovery?.getState().pending ?? []) {
          if (pending.status === 'auth-required' || pending.status === 'security-required' || pending.status === 'contributions-revoked' || pending.status === 'blocked') notifications.notify({ kind: 'upload-failed', id: pending.revision }, settingsStore.get().notifications ?? { uploadFailures: false, updates: false })
        }
        void publishState().catch(reportBackgroundError)
      }
    })
    recovery.pause()
    await recovery.load()
    watcher = new WorldFileWatcher(async (filePath) => { if (account) await upload(filePath, true) })
    startup = await readStartup(startupOptions())
    nativeLauncherPath = settingsStore.get().nativeBattleNetPath ?? (capabilities.nativeBattleNet ? await discoverNativeLauncher({ platform: process.platform, homeDirectory: os.homedir() }) : null)
    const credential = await tokenStore.get()
    const cachedAccount = settingsStore.get().desktopAccount
    if (credential && cachedAccount && cachedAccount.origin === settingsStore.get().baseUrl && cachedAccount.tokenHash === createHash('sha256').update(credential).digest('hex')) {
      account = { id: cachedAccount.id, name: cachedAccount.name }
    }
    if (capabilities.managedWowLauncher) {
      wowLauncher = WowLauncher.create({
        homeDirectory: os.homedir(),
        platform: process.platform,
        launcherSettings: () => settingsStore.get().wowLauncher,
        onChange: () => {
          void publishState()
        }
      })
      await wowLauncher.refresh()
    }
    const updaterKind = desktopUpdaterKind({
      automaticUpdates: capabilities.automaticUpdates,
      packaged: app.isPackaged,
      platform: process.platform
    })
    if (updaterKind === 'automatic') appUpdater = new AppUpdater(autoUpdater, {
      currentVersion: app.getVersion(),
      enabled: true,
      forceDevUpdateConfig: !app.isPackaged,
      feedUrl: updateFeedUrl(),
      isUploading: () => uploader.isBusy(),
      onState: () => {
        notifyUpdate()
        void publishState()
      },
      promptToRestart: async () => false
    })
    if (updaterKind === 'manual') appUpdater = new ManualUpdater({
      currentVersion: app.getVersion(), arch: process.arch,
      baseUrl: () => settingsStore.get().baseUrl, openExternal: (url) => shell.openExternal(url), onState: () => { notifyUpdate(); void publishState() }
    })
    registerIpc()
    createWindow()
    startTray()
    if (tray === null && process.argv.includes('--background')) showWindow()
    await publishState()
    await restartWatcher()
    appUpdater?.start()
    await queueCurrentFiles()
    void verifyAccount().then(publishState).catch(reportBackgroundError)
    setInterval(() => { resumeIngestPolling(); void rescanFiles().catch(reportBackgroundError) }, 30_000).unref()
    void addons.refresh()

    const initialProtocolUrl = protocolUrlFromArguments(process.argv)
    if (initialProtocolUrl) pendingProtocolUrls.add(initialProtocolUrl)
    readyForProtocol = true
    for (const protocolUrl of pendingProtocolUrls) {
      await handleProtocolUrl(protocolUrl)
    }
    pendingProtocolUrls.clear()
  }).catch((error: unknown) => {
    reportBackgroundError(error)
    const savedState = error instanceof Error && error.message === 'Could not read the saved desktop state.'
    dialog.showErrorBox(
      'Everlook could not start',
      savedState
        ? 'Could not read the saved desktop state. Check disk space and permissions, then reopen Everlook.'
        : 'Everlook could not finish starting. Check disk space and permissions, then reopen Everlook.'
    )
    app.quit()
  })
}

app.on('before-quit', (event) => {
  if (shutdownComplete) return
  event.preventDefault()
  if (quitting) return
  quitting = true
  suspendSession()
  appUpdater?.close()
  void Promise.allSettled([recovery?.close(), watcher?.close(), tokenStore?.flush()]).then(() => {
    shutdownComplete = true
    app.quit()
  })
})

app.on('window-all-closed', () => {
  // After a SIGTERM or SIGINT, the second app.quit() above closes the windows but lands here
  // instead of quitting, so a Mac would stay running with no window.
  if (process.platform !== 'darwin' || quitting) app.quit()
})

app.on('activate', () => { if (readyForProtocol) showWindow() })
