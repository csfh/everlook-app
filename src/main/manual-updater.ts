import { z } from 'zod'
import type { UpdateState } from '../shared/types'
import { compareAddonVersions } from './addon-install'
import { boundedRequest } from './request'
import type { DesktopUpdater } from './updater'

const releaseSchema = z.object({
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  artifacts: z.array(z.object({
    id: z.string(), platform: z.string(), arch: z.string(), filename: z.string(),
    size: z.number().int().positive(), sha256: z.string().regex(/^[a-f0-9]{64}$/)
  }))
})

/** Unsigned macOS releases are downloaded explicitly and installed by the user. */
export class ManualUpdater implements DesktopUpdater {
  private state: UpdateState
  private controller: AbortController | null = null
  constructor(private readonly options: {
    currentVersion: string; baseUrl: () => string; arch: string
    request?: typeof fetch; openExternal: (url: string) => Promise<void>
    onState: () => void
  }) {
    this.state = {
      mode: 'manual', status: 'idle', currentVersion: options.currentVersion,
      availableVersion: null, downloadPercent: null, downloadUrl: null, error: null
    }
  }
  getState(): UpdateState { return { ...this.state } }
  start(): void { void this.check() }
  close(): void { this.controller?.abort() }
  async check(): Promise<void> {
    if (this.state.status === 'checking') return
    const controller = new AbortController()
    this.controller = controller
    this.set({ status: 'checking', error: null, downloadUrl: null })
    try {
      const origin = new URL(this.options.baseUrl()).origin
      const response = await boundedRequest(this.options.request ?? fetch, `${origin}/download/desktop.json`, {}, { signal: controller.signal })
      if (!response.ok) throw new Error(`The desktop release manifest could not be read (HTTP ${response.status}).`)
      const release = releaseSchema.parse(await response.json())
      const artifact = release.artifacts.find((item) => item.id === `macos-${this.options.arch}` && item.platform === 'darwin' && item.arch === this.options.arch)
      if (!artifact || artifact.filename !== `Everlook-${release.version}-mac-${this.options.arch}.dmg`) {
        throw new Error('There is no download for this Mac architecture in the published release.')
      }
      this.set(compareAddonVersions(release.version, this.options.currentVersion) > 0
        ? { status: 'available', availableVersion: release.version, downloadUrl: `${origin}/download/macos-${this.options.arch}` }
        : { status: 'current', availableVersion: null })
    } catch (error) {
      if (!controller.signal.aborted) this.set({ status: 'error', error: manualCheckError(error) })
    } finally { if (this.controller === controller) this.controller = null }
  }
  async install(): Promise<void> {
    if (this.state.status !== 'available' || !this.state.downloadUrl) throw new Error('Check for an available update first.')
    await this.options.openExternal(this.state.downloadUrl)
  }
  async promptIfReady(): Promise<void> { /* Downloads require an explicit user action. */ }
  private set(update: Partial<UpdateState>): void { this.state = { ...this.state, ...update }; this.options.onState() }
}

function manualCheckError(error: unknown): string {
  if (error instanceof z.ZodError || error instanceof SyntaxError) {
    return 'The desktop release manifest could not be read.'
  }
  if (error instanceof Error) {
    if (
      error.message.startsWith('The desktop release manifest could not be read') ||
      error.message.startsWith('There is no download for this Mac')
    ) {
      return error.message
    }
  }
  return 'Could not check for a Mac update. Try again when Everlook is reachable.'
}
