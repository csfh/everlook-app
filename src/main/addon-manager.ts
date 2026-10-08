import { commonWowRoots } from './discovery'
import { addonDownloadUrl, discoverAddonsDirectories, inspectInstalledAddon, installAddon } from './addon-install'
import { loadInstallationCatalog, resolveAddonDirectory, retainInstallStatus } from './installation-catalog'
import { boundedRequest } from './request'
import type { AddonInstallState, InstallationState, Settings, SigningPlaceResult, SigningState } from '../shared/types'
import { idleSigningState } from './signing-status'
import { canWriteSigningToken, requestSigningSecret, writeSigningToken } from './signing-token'

export type AddonManagerOptions = {
  settings: { get(): Settings; update(update: Partial<Settings>): Promise<Settings> }
  /** The signed-in account's token, or null when nobody is signed in. */
  token: () => Promise<string | null>
  /** The current session's abort signal. A new session brings a new signal. */
  signal: () => AbortSignal
  userDataDirectory: () => string
  /** Pushes the app state to the window and tray after this manager changes it. */
  publish: () => Promise<void>
  /** Installation roots the machine suggests on its own. Defaults to the usual WoW folders. */
  roots?: () => Promise<string[]>
  fetchImpl?: typeof fetch
}

export function idleAddonState(): AddonInstallState {
  return {
    status: 'idle',
    addonsPath: null,
    version: null,
    publishedVersion: null,
    title: null,
    interface: null,
    error: null
  }
}

/**
 * Keeps the app's picture of every WoW installation it watches: which have
 * the addon, which version, and whether the signing token is in place. One
 * refresh or install runs at a time; a call that arrives while one is busy
 * returns without doing anything.
 */
export class AddonManager {
  private installationStates: InstallationState[] = []
  private signingState: SigningState = idleSigningState()
  private addonState: AddonInstallState = idleAddonState()
  private busy = false

  constructor(private readonly options: AddonManagerOptions) {}

  get installations(): InstallationState[] {
    return this.installationStates
  }

  get signing(): SigningState {
    return this.signingState
  }

  get addon(): AddonInstallState {
    return this.addonState
  }

  /** Reads every installation again and publishes the result, with a checking state in between. */
  async refresh(): Promise<void> {
    if (this.busy) return
    this.busy = true
    this.addonState = { ...this.addonState, status: 'checking', error: null }
    await this.options.publish()
    try {
      await this.applyCatalog()
    } catch (error) {
      this.addonState = {
        ...this.addonState,
        status: 'error',
        error: error instanceof Error ? error.message : 'Could not check Everlook.'
      }
    } finally {
      this.busy = false
      await this.options.publish()
    }
  }

  /** The saved installation roots plus the ones the machine suggests. */
  async installationRoots(): Promise<string[]> {
    const settings = this.options.settings.get()
    const suggested = await (this.options.roots ?? commonWowRoots)()
    return [...new Set([...(settings.installationRoots ?? []), ...suggested])]
  }

  /** Re-reads the signing status of known installations without resetting their install status. */
  async applyCatalogSigning(): Promise<void> {
    const refreshed = retainInstallStatus(this.installationStates, await this.loadCatalog())
    this.installationStates = refreshed.installations
    this.signingState = refreshed.signing
  }

  /** Downloads and installs the addon, then places the signing token when someone is signed in. */
  async install(addonsPath?: string): Promise<void> {
    if (this.busy) return
    const addonsDirectory = resolveAddonDirectory(await this.addonDirectories(), addonsPath)
    this.busy = true
    try {
      const installed = await inspectInstalledAddon(addonsDirectory)
      if (installed.symlink || installed.gitCheckout) throw new Error('This installation is a protected development checkout.')
      await installAddon({
        downloadUrl: addonDownloadUrl(this.options.settings.get().baseUrl),
        fetchImpl: (input, init) => this.request(input, init, 120_000),
        addonsDirectory,
        userDataDirectory: this.options.userDataDirectory()
      })
      if ((await this.options.token()) !== null) await this.placeSigningToken(addonsDirectory)
    } finally {
      this.busy = false
      await this.refresh()
      await this.options.publish()
    }
  }

  /** Writes the account's signing token into the addon, or reports why it was skipped. */
  async placeSigningToken(addonsPath?: string): Promise<SigningPlaceResult> {
    const signal = this.options.signal()
    const settings = this.options.settings.get()
    const token = await this.options.token()
    signal.throwIfAborted()
    if (token === null) {
      throw new Error('Sign in to Everlook before placing a signing token.')
    }
    const addonsDirectory = resolveAddonDirectory(await this.addonDirectories(), addonsPath)
    const installed = await inspectInstalledAddon(addonsDirectory)
    if (!installed.present) throw new Error('Install the Everlook addon before placing a signing token.')
    if (!(await canWriteSigningToken(addonsDirectory))) {
      signal.throwIfAborted()
      await this.applyCatalog()
      await this.options.publish()
      return { placed: 0, skipped: 1 }
    }
    signal.throwIfAborted()
    const { secret, signer } = await requestSigningSecret(settings.baseUrl, token, (input, init) => this.request(input, init))
    signal.throwIfAborted()
    await writeSigningToken(addonsDirectory, secret)
    signal.throwIfAborted()
    await this.options.settings.update({ accountSigner: signer })
    signal.throwIfAborted()
    await this.applyCatalog()
    await this.options.publish()
    return { placed: 1, skipped: 0 }
  }

  private async addonDirectories(): Promise<string[]> {
    return discoverAddonsDirectories(this.options.settings.get().selectedFiles, await this.installationRoots())
  }

  private async loadCatalog() {
    const settings = this.options.settings.get()
    return loadInstallationCatalog({
      selectedFiles: settings.selectedFiles,
      roots: await this.installationRoots(),
      baseUrl: settings.baseUrl,
      accountSigner: settings.accountSigner ?? null,
      fetch: (input, init) => this.request(input, init)
    })
  }

  private async applyCatalog(): Promise<void> {
    const catalog = await this.loadCatalog()
    this.installationStates = catalog.installations
    this.signingState = catalog.signing
    this.addonState = catalog.addon
  }

  private request(input: Parameters<typeof fetch>[0], init: RequestInit | undefined, timeoutMs?: number): Promise<Response> {
    const signal = this.options.signal()
    return boundedRequest(this.options.fetchImpl ?? fetch, input, init, timeoutMs === undefined ? { signal } : { signal, timeoutMs })
  }
}
