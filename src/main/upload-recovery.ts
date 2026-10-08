import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, stat } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { UNSTABLE_WORLD_FILE_CODE, uploadOutcome, type UploadResult } from './uploader'

export type UploadContext = { origin: string; accountId: number }

export type PendingUpload = {
  path: string
  scope: string
  revision: string
  force: boolean
  queuedAt: string
  status: 'queued' | 'uploading' | 'retrying' | 'auth-required' | 'security-required' | 'contributions-revoked' | 'blocked'
  attempts: number
  nextAttemptAt: string | null
  error: string | null
  setupUrl: string | null
}

export type UploadHistoryEntry = {
  id: string
  path: string
  scope: string
  at: string
  outcome: 'uploaded' | 'unchanged' | 'error'
  hash: string | null
  uploadId: number | null
  ingestStatus: string | null
  signed: 'signed' | 'unsigned' | null
  error: string | null
}

type IngestVerdict = {
  id: number
  status: string
  signed: 'signed' | 'unsigned' | null
  error: string | null
}

type Dependencies = {
  directory: string
  context: () => UploadContext | null
  upload: (filePath: string, force: boolean, signal: AbortSignal) => Promise<UploadResult>
  onChange: () => void
  clock?: () => number
  /** Schedule one callback; return a function that cancels it. */
  schedule?: (callback: () => void, delayMs: number) => () => void
}

const knownPendingStatus = z.enum(['queued', 'uploading', 'retrying', 'auth-required', 'security-required', 'contributions-revoked', 'blocked'])

const pendingSchema = z.object({
  path: z.string(),
  scope: z.string(),
  revision: z.string(),
  force: z.boolean(),
  queuedAt: z.iso.datetime(),
  status: z.string().transform((value): PendingUpload['status'] => knownPendingStatus.safeParse(value).success ? value as PendingUpload['status'] : 'queued'),
  attempts: z.number().int().nonnegative(),
  nextAttemptAt: z.iso.datetime().nullable(),
  error: z.string().nullable(),
  setupUrl: z.string().nullable().optional().default(null)
}).strict()

const historySchema = z.object({
  id: z.string(),
  path: z.string(),
  scope: z.string(),
  at: z.iso.datetime(),
  outcome: z.enum(['uploaded', 'unchanged', 'error']),
  hash: z.string().nullable(),
  uploadId: z.number().int().nullable(),
  ingestStatus: z.string().nullable(),
  signed: z.enum(['signed', 'unsigned']).nullable(),
  error: z.string().nullable()
}).strict()

const storedSchema = z.object({
  version: z.literal(1),
  pending: z.array(pendingSchema),
  history: z.array(historySchema)
}).strict()

export function uploadScope(context: UploadContext): string {
  if (!Number.isSafeInteger(context.accountId) || context.accountId <= 0) {
    throw new Error('Upload recovery requires an authenticated account ID.')
  }
  const origin = new URL(context.origin)
  if (origin.protocol !== 'https:' && origin.protocol !== 'http:') {
    throw new Error('Upload recovery requires an HTTP origin.')
  }
  return `${origin.origin}|${context.accountId}`
}

function key(scope: string, filePath: string): string {
  return JSON.stringify([scope, filePath])
}

function errorProperty(error: unknown, property: string): unknown {
  if (error !== null && typeof error === 'object' && property in error) {
    return Reflect.get(error, property)
  }
  return undefined
}

function isAborted(error: unknown): boolean {
  return errorProperty(error, 'name') === 'AbortError'
}

function safeError(message: string | null): string | null {
  if (message === null) return null
  return message
    .replace(/https?:\/\/\S+/gi, '[url]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/((?:token|signature|credential|authorization|secret)["']?\s*[:=]\s*)[^\s,;]+/gi, '$1[redacted]')
    .slice(0, 500)
}

function isNetworkFailure(error: unknown): boolean {
  return error instanceof TypeError || errorProperty(error, 'name') === 'TimeoutError' ||
    ['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'EPIPE', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET']
      .includes(String(errorProperty(error, 'code')))
}

const AUTH_HOLD_MESSAGE = 'Sign in to Everlook again to resume uploads.'
const SECURITY_HOLD_MESSAGE = 'Finish securing your account on everlook.ing to resume uploads.'
const REVOKED_HOLD_MESSAGE = 'Contributions from this account were revoked.'

function setupUrlOf(error: unknown): string | null {
  const setupUrl = errorProperty(error, 'setupUrl')
  return typeof setupUrl === 'string' && setupUrl !== '' ? setupUrl : null
}

function retryFailure(error: unknown): { status: PendingUpload['status']; delay: number | null; message: string; setupUrl: string | null } {
  const lastStatus = errorProperty(error, 'httpStatus')
  // A multi-step upload can lose the network after an earlier successful response.
  const httpStatus = typeof lastStatus === 'number' && lastStatus >= 200 && lastStatus < 300 &&
    isNetworkFailure(errorProperty(error, 'cause')) ? null : lastStatus
  if (errorProperty(error, 'code') === 'security_required') {
    return { status: 'security-required', delay: null, message: SECURITY_HOLD_MESSAGE, setupUrl: setupUrlOf(error) }
  }
  if (errorProperty(error, 'code') === 'contributions_revoked') {
    return { status: 'contributions-revoked', delay: null, message: REVOKED_HOLD_MESSAGE, setupUrl: null }
  }
  if (httpStatus === 401 || httpStatus === 403) {
    return { status: 'auth-required', delay: null, message: AUTH_HOLD_MESSAGE, setupUrl: null }
  }
  const code = errorProperty(error, 'code')
  if (code === UNSTABLE_WORLD_FILE_CODE) {
    return {
      status: 'retrying',
      delay: 0,
      message: 'Everlook.lua is still changing. Everlook will try again after it settles.',
      setupUrl: null
    }
  }
  if (code === 'ENOENT' || code === 'ENOTDIR') {
    return { status: 'blocked', delay: null, message: 'World file is missing. Restore it and retry.', setupUrl: null }
  }
  if (code === 'EACCES' || code === 'EPERM' || code === 'EISDIR') {
    return { status: 'blocked', delay: null, message: 'World file cannot be read. Check its permissions and retry.', setupUrl: null }
  }
  if (typeof httpStatus === 'number') {
    const transient = [408, 425, 429].includes(httpStatus) || (httpStatus >= 500 && httpStatus <= 599)
    if (!transient) {
      return { status: 'blocked', delay: null, message: `Everlook rejected the upload (HTTP ${httpStatus}). Retry after resolving the error.`, setupUrl: null }
    }
  } else {
    const network = httpStatus === null || isNetworkFailure(error) || isNetworkFailure(errorProperty(error, 'cause'))
    if (!network) {
      return { status: 'blocked', delay: null, message: 'Upload could not be completed. Check the world file and retry.', setupUrl: null }
    }
  }
  const retryAfter = errorProperty(error, 'retryAfterMs')
  return {
    status: 'retrying',
    delay: typeof retryAfter === 'number' && Number.isFinite(retryAfter) ? Math.max(0, retryAfter) : 0,
    message: typeof httpStatus === 'number' ? `Everlook is temporarily unavailable (HTTP ${httpStatus}).` : 'Everlook could not be reached. Waiting to retry.',
    setupUrl: null
  }
}

/** Keeps only metadata. The uploader reads the latest file contents when each task starts. */
export class UploadRecoveryService {
  private pending = new Map<string, PendingUpload>()
  private history: UploadHistoryEntry[] = []
  private readonly authRequired = new Set<string>()
  private readonly securityRequired = new Set<string>()
  private readonly contributionsRevoked = new Set<string>()
  private readonly securitySetupUrl = new Map<string, string>()
  private readonly filename: string
  private readonly clock: () => number
  private readonly schedule: NonNullable<Dependencies['schedule']>
  private writeTail: Promise<void> = Promise.resolve()
  private loading: Promise<void> | null = null
  private draining: Promise<void> | null = null
  private active: { key: string; controller: AbortController } | null = null
  private cancelTimer: (() => void) | null = null
  private paused = false
  private pauseVersion = 0
  private closed = false

  constructor(private readonly dependencies: Dependencies) {
    this.filename = path.join(dependencies.directory, 'upload-recovery.json')
    this.clock = dependencies.clock ?? Date.now
    this.schedule = dependencies.schedule ?? ((callback, delayMs) => {
      const timer = setTimeout(callback, delayMs)
      timer.unref()
      return () => clearTimeout(timer)
    })
  }

  load(): Promise<void> {
    this.loading ??= this.readStored()
    return this.loading
  }

  async enqueue(filePath: string, force = false): Promise<void> {
    const scope = this.currentScope()
    const pauseVersion = this.pauseVersion
    if (scope === null) throw new Error('Sign in to Everlook before queueing an upload.')
    await this.load()
    this.ensureOpen()
    if (scope !== this.currentScope() || pauseVersion !== this.pauseVersion) {
      throw new DOMException('Upload context changed before this export was queued.', 'AbortError')
    }
    const normalized = path.resolve(filePath)
    const entryKey = key(scope, normalized)
    const previous = this.pending.get(entryKey)
    const held = this.hold(scope)
    this.pending.set(entryKey, {
      path: normalized,
      scope,
      revision: randomUUID(),
      force: force || previous?.force === true,
      queuedAt: this.timestamp(),
      status: held.status,
      attempts: 0,
      nextAttemptAt: null,
      error: held.error,
      setupUrl: held.setupUrl
    })
    await this.persist()
    this.changed()
  }

  async retry(filePath: string): Promise<void> {
    // A deliberate retry bypasses the uploader's previous-hash shortcut.
    await this.enqueue(filePath, true)
  }

  drain(): Promise<void> {
    if (this.draining !== null) return this.draining
    const running = this.run().finally(() => {
      this.draining = null
      this.armTimer()
    })
    this.draining = running
    return running
  }

  pause(): void {
    this.pauseVersion += 1
    this.paused = true
    this.clearTimer()
    this.active?.controller.abort()
    this.dependencies.onChange()
  }

  async resume(): Promise<void> {
    const pauseVersion = this.pauseVersion
    const scope = this.currentScope()
    await this.load()
    this.ensureOpen()
    if (pauseVersion !== this.pauseVersion || scope !== this.currentScope()) return
    this.paused = false
    if (scope !== null) {
      this.authRequired.delete(scope)
      for (const entry of this.pending.values()) {
        if (entry.scope === scope && entry.status === 'auth-required') {
          entry.status = 'queued'
          entry.nextAttemptAt = null
          entry.error = null
          entry.setupUrl = null
        }
      }
    }
    await this.persist()
    if (pauseVersion !== this.pauseVersion || scope !== this.currentScope()) return
    this.changed()
    await this.drain()
  }

  async releaseSecurity(): Promise<void> {
    const pauseVersion = this.pauseVersion
    const scope = this.currentScope()
    await this.load()
    this.ensureOpen()
    if (pauseVersion !== this.pauseVersion || scope === null || scope !== this.currentScope()) return
    this.securityRequired.delete(scope)
    this.securitySetupUrl.delete(scope)
    for (const entry of this.pending.values()) {
      if (entry.scope === scope && entry.status === 'security-required') {
        entry.status = 'queued'
        entry.nextAttemptAt = null
        entry.error = null
        entry.setupUrl = null
      }
    }
    await this.persist()
    if (pauseVersion !== this.pauseVersion || scope !== this.currentScope()) return
    this.changed()
    if (!this.paused) await this.drain()
  }

  async remove(filePath: string): Promise<void> {
    await this.load()
    this.ensureOpen()
    const normalized = path.resolve(filePath)
    for (const [entryKey, entry] of this.pending) {
      if (entry.path !== normalized) continue
      this.pending.delete(entryKey)
      if (this.active?.key === entryKey) this.active.controller.abort()
    }
    await this.persist()
    this.changed()
  }

  async close(): Promise<void> {
    if (this.closed) {
      await this.draining
      await this.writeTail
      return
    }
    this.closed = true
    this.pause()
    await this.loading
    await this.draining
    await this.writeTail
  }

  getState(): { pending: PendingUpload[]; history: UploadHistoryEntry[] } {
    const scope = this.currentScope()
    const pending = [...this.pending.values()].filter((entry) => entry.scope === scope).map((entry) => Object.freeze({ ...entry }))
    const history = this.history.filter((entry) => entry.scope === scope).map((entry) => Object.freeze({ ...entry }))
    Object.freeze(pending)
    Object.freeze(history)
    return Object.freeze({ pending, history })
  }

  async updateIngest(hash: string, verdict: IngestVerdict): Promise<void> {
    const scope = this.currentScope()
    const pauseVersion = this.pauseVersion
    await this.load()
    this.ensureOpen()
    if (scope === null || scope !== this.currentScope() || pauseVersion !== this.pauseVersion) return
    let updated = false
    for (const entry of this.history) {
      if (entry.scope !== scope || entry.hash !== hash || entry.outcome === 'error') continue
      if (entry.uploadId !== null && entry.uploadId !== verdict.id) continue
      entry.uploadId = verdict.id
      entry.ingestStatus = verdict.status
      entry.signed = verdict.signed
      entry.error = safeError(verdict.error)
      updated = true
    }
    if (updated) {
      await this.persist()
      this.changed()
    }
  }

  private ensureOpen(): void {
    if (this.closed) throw new Error('Upload recovery is closed.')
  }

  private currentScope(): string | null {
    const context = this.dependencies.context()
    return context === null ? null : uploadScope(context)
  }

  private queueHeld(scope: string): boolean {
    return this.authRequired.has(scope) || this.securityRequired.has(scope) || this.contributionsRevoked.has(scope)
  }

  private hold(scope: string): { status: PendingUpload['status']; error: string | null; setupUrl: string | null } {
    if (this.authRequired.has(scope)) return { status: 'auth-required', error: AUTH_HOLD_MESSAGE, setupUrl: null }
    if (this.securityRequired.has(scope)) return { status: 'security-required', error: SECURITY_HOLD_MESSAGE, setupUrl: this.securitySetupUrl.get(scope) ?? null }
    if (this.contributionsRevoked.has(scope)) return { status: 'contributions-revoked', error: REVOKED_HOLD_MESSAGE, setupUrl: null }
    return { status: 'queued', error: null, setupUrl: null }
  }

  private timestamp(): string {
    return new Date(this.clock()).toISOString()
  }

  private async readStored(): Promise<void> {
    let contents: string
    try {
      contents = await readFile(this.filename, 'utf8')
    } catch (error) {
      if (errorProperty(error, 'code') !== 'ENOENT') throw error
      return
    }
    const stored = storedSchema.parse(JSON.parse(contents) as unknown)
    for (const entry of stored.pending) {
      // A process may stop at any point during a send. Only a completed send removes this record.
      if (entry.status === 'uploading') entry.status = 'queued'
      this.pending.set(key(entry.scope, entry.path), entry)
      if (entry.status === 'auth-required') this.authRequired.add(entry.scope)
      if (entry.status === 'security-required') {
        this.securityRequired.add(entry.scope)
        if (entry.setupUrl) this.securitySetupUrl.set(entry.scope, entry.setupUrl)
      }
      if (entry.status === 'contributions-revoked') this.contributionsRevoked.add(entry.scope)
    }
    this.history = stored.history
    this.trimHistory()
    await this.persist()
    this.changed()
  }

  private persist(): Promise<void> {
    const contents = JSON.stringify({ version: 1, pending: [...this.pending.values()], history: this.history })
    // Each caller observes its own write failure; a later explicit retry may attempt another write.
    const writing = this.writeTail.catch(() => undefined).then(async () => {
      await mkdir(this.dependencies.directory, { recursive: true, mode: 0o700 })
      const temporary = `${this.filename}.tmp`
      const file = await open(temporary, 'w', 0o600)
      try {
        // Creation mode alone cannot repair a temporary file left by an older process.
        await file.chmod(0o600)
        await file.writeFile(contents)
      } finally {
        await file.close()
      }
      await rename(temporary, this.filename)
    })
    this.writeTail = writing
    return writing
  }

  private changed(): void {
    this.dependencies.onChange()
    this.armTimer()
  }

  private clearTimer(): void {
    this.cancelTimer?.()
    this.cancelTimer = null
  }

  private eligible(scope: string): PendingUpload[] {
    return [...this.pending.values()].filter((entry) => entry.scope === scope &&
      (entry.status === 'queued' || entry.status === 'retrying'))
  }

  private armTimer(): void {
    this.clearTimer()
    if (this.closed || this.paused || this.draining !== null) return
    const scope = this.currentScope()
    if (scope === null || this.queueHeld(scope)) return
    const deadlines = this.eligible(scope).map((entry) => entry.nextAttemptAt === null ? this.clock() : Date.parse(entry.nextAttemptAt))
    if (deadlines.length === 0) return
    // Node clamps delays above 2^31-1 to 1ms; recheck very long Retry-After deadlines in chunks.
    const delay = Math.min(2_147_483_647, Math.max(0, Math.min(...deadlines) - this.clock()))
    this.cancelTimer = this.schedule(() => {
      this.cancelTimer = null
      void this.drain().catch((error: unknown) => {
        this.pause()
        console.error('Could not persist upload recovery state:', error)
      })
    }, delay)
  }

  private async run(): Promise<void> {
    await this.load()
    this.clearTimer()
    const scope = this.currentScope()
    if (scope === null) return
    while (!this.closed && !this.paused && this.currentScope() === scope && !this.queueHeld(scope)) {
      const next = this.eligible(scope).find((entry) => entry.nextAttemptAt === null || Date.parse(entry.nextAttemptAt) <= this.clock())
      if (next === undefined) return
      await this.send({ ...next })
    }
  }

  private async send(entry: PendingUpload): Promise<void> {
    const entryKey = key(entry.scope, entry.path)
    const controller = new AbortController()
    this.active = { key: entryKey, controller }
    const current = this.pending.get(entryKey)
    if (current?.revision !== entry.revision) {
      this.active = null
      return
    }
    current.status = 'uploading'
    current.nextAttemptAt = null
    try {
      await this.persist()
      this.dependencies.onChange()
      if (controller.signal.aborted || this.closed || this.paused || this.currentScope() !== entry.scope) {
        await this.restoreAborted(entry)
        return
      }
      let result: UploadResult
      try {
        const file = await stat(entry.path)
        if (!file.isFile()) throw Object.assign(new Error('World file is not a regular file.'), { code: 'EISDIR' })
        if (controller.signal.aborted || this.closed || this.paused || this.currentScope() !== entry.scope) {
          await this.restoreAborted(entry)
          return
        }
        result = await this.dependencies.upload(entry.path, entry.force, controller.signal)
      } catch (error) {
        if (controller.signal.aborted || isAborted(error) || this.currentScope() !== entry.scope) {
          await this.restoreAborted(entry)
        } else {
          await this.recordFailure(entry, error)
        }
        return
      }
      if (controller.signal.aborted || this.currentScope() !== entry.scope) {
        await this.restoreAborted(entry)
        return
      }
      await this.recordSuccess(entry, result)
    } finally {
      this.active = null
    }
  }

  private async restoreAborted(entry: PendingUpload): Promise<void> {
    const current = this.pending.get(key(entry.scope, entry.path))
    if (current?.revision === entry.revision) {
      current.status = 'queued'
      current.nextAttemptAt = null
      await this.persist()
      this.dependencies.onChange()
    }
  }

  private async recordFailure(entry: PendingUpload, error: unknown): Promise<void> {
    const failure = retryFailure(error)
    const current = this.pending.get(key(entry.scope, entry.path))
    if (current === undefined) return
    if (failure.status === 'auth-required' || failure.status === 'security-required' || failure.status === 'contributions-revoked') {
      const held = failure.status
      if (held === 'auth-required') this.authRequired.add(entry.scope)
      if (held === 'security-required') {
        this.securityRequired.add(entry.scope)
        if (failure.setupUrl) this.securitySetupUrl.set(entry.scope, failure.setupUrl)
      }
      if (held === 'contributions-revoked') this.contributionsRevoked.add(entry.scope)
      for (const pending of this.pending.values()) {
        if (pending.scope !== entry.scope || pending.status === 'blocked') continue
        pending.status = held
        pending.nextAttemptAt = null
        pending.error = failure.message
        pending.setupUrl = held === 'security-required' ? failure.setupUrl : null
      }
    } else if (current.revision === entry.revision) {
      current.status = failure.status
      current.attempts += 1
      const backoff = Math.min(300_000, 30_000 * 2 ** Math.min(current.attempts - 1, 4))
      current.nextAttemptAt = failure.delay === null ? null : new Date(this.clock() + Math.max(backoff, failure.delay)).toISOString()
      current.error = failure.message
      current.setupUrl = null
    }
    this.addHistory({
      id: randomUUID(), path: entry.path, scope: entry.scope, at: this.timestamp(),
      outcome: 'error', hash: null, uploadId: null, ingestStatus: null, signed: null, error: failure.message
    })
    await this.persist()
    this.dependencies.onChange()
  }

  private async recordSuccess(entry: PendingUpload, result: UploadResult): Promise<void> {
    const entryKey = key(entry.scope, entry.path)
    const current = this.pending.get(entryKey)
    if (current === undefined) return
    const exchange = result.responses.findLast((response) => response.step !== 'storage')
    const previousHistory = this.history.slice()
    this.addHistory({
      id: randomUUID(), path: entry.path, scope: entry.scope, at: this.timestamp(),
      outcome: uploadOutcome(result), hash: result.hash, uploadId: exchange?.uploadId ?? null,
      ingestStatus: exchange?.uploadStatus ?? null, signed: null, error: null
    })
    if (current.revision === entry.revision) this.pending.delete(entryKey)
    try {
      await this.persist()
    } catch (error) {
      // Leave a recoverable task when acknowledging a successful send fails on disk.
      if (!this.pending.has(entryKey)) this.pending.set(entryKey, { ...entry, status: 'queued' })
      this.history = previousHistory
      throw error
    }
    this.dependencies.onChange()
  }

  private addHistory(entry: UploadHistoryEntry): void {
    this.history.unshift(entry)
    this.trimHistory()
  }

  private trimHistory(): void {
    const counts = new Map<string, number>()
    this.history = this.history.filter((entry) => {
      const count = (counts.get(entry.scope) ?? 0) + 1
      counts.set(entry.scope, count)
      return count <= 200
    })
  }
}
