import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { UploadRecoveryService, uploadScope } from './upload-recovery'
import { UNSTABLE_WORLD_FILE_CODE, UploadError, type UploadResult } from './uploader'

function result(hash = 'a'.repeat(64)): UploadResult {
  return {
    hash,
    uploadedAt: '2026-10-03T12:00:00.000Z',
    unchanged: false,
    responses: [{ step: 'queue', status: 202, message: null, uploadId: 42, uploadStatus: 'pending', duplicate: false }]
  }
}

function failure(httpStatus: number | null, retryAfterMs: number | null = null): Error {
  return Object.assign(new Error('Upload failed'), { name: 'UploadError', httpStatus, retryAfterMs })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

describe('UploadRecoveryService', () => {
  let directory: string
  let file: string
  let context: { origin: string; accountId: number } | null
  let now: number
  let timers: Map<() => void, number>
  let services: UploadRecoveryService[]
  const upload = vi.fn<(file: string, force: boolean, signal: AbortSignal) => Promise<UploadResult>>()

  function service() {
    const recovery = new UploadRecoveryService({
      directory,
      context: () => context,
      upload,
      onChange: vi.fn(),
      clock: () => now,
      schedule: (callback, milliseconds) => {
        timers.set(callback, now + milliseconds)
        return () => { timers.delete(callback) }
      }
    })
    services.push(recovery)
    return recovery
  }

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'everlook-recovery-'))
    file = path.join(directory, 'Everlook.lua')
    await writeFile(file, 'EverlookDB = {}')
    context = { origin: 'https://everlook.test', accountId: 1 }
    now = Date.parse('2026-10-03T12:00:00Z')
    timers = new Map()
    services = []
    upload.mockReset().mockResolvedValue(result())
  })

  afterEach(async () => {
    await Promise.all(services.map((recovery) => recovery.close()))
    await rm(directory, { recursive: true, force: true })
  })

  it('coalesces queued exports, persists before sending, and stores only safe metadata', async () => {
    const recovery = service()
    await recovery.load()
    await recovery.enqueue(file)
    await recovery.enqueue(file, true)
    expect(recovery.getState().pending).toHaveLength(1)
    upload.mockImplementationOnce(async () => {
      const stored = JSON.parse(await readFile(path.join(directory, 'upload-recovery.json'), 'utf8'))
      expect(stored.pending).toHaveLength(1)
      expect(stored.history).toHaveLength(0)
      return { ...result(), responses: [{ ...result().responses[0]!, message: 'secret response https://bucket.test/?signature=secret', step: 'queue', status: 202, uploadId: 42, uploadStatus: 'pending', duplicate: false }] }
    })
    await recovery.drain()
    expect(upload).toHaveBeenCalledTimes(1)
    expect(upload.mock.calls[0]?.[1]).toBe(true)
    expect(recovery.getState().pending).toEqual([])
    expect(recovery.getState().history[0]).toMatchObject({ outcome: 'uploaded', ingestStatus: 'pending', signed: null, uploadId: 42 })
    const persisted = await readFile(path.join(directory, 'upload-recovery.json'), 'utf8')
    expect(persisted).not.toContain('secret')
    expect(persisted).not.toContain('EverlookDB')
    expect(persisted).not.toContain('responses')
    if (process.platform !== 'win32') expect((await stat(path.join(directory, 'upload-recovery.json'))).mode & 0o777).toBe(0o600)
  })

  it('keeps an export that changes during an active send and serializes all sends', async () => {
    const recovery = service()
    const active = deferred<UploadResult>()
    const started = deferred<void>()
    upload.mockImplementationOnce(async () => { started.resolve(); return active.promise })
    await recovery.load()
    await recovery.enqueue(file)
    const draining = recovery.drain()
    await started.promise
    await writeFile(file, 'EverlookDB = { changed = true }')
    await recovery.enqueue(file)
    await recovery.enqueue(file)
    expect(upload).toHaveBeenCalledTimes(1)
    active.resolve(result())
    await draining
    expect(upload).toHaveBeenCalledTimes(2)
    expect(recovery.getState().history).toHaveLength(2)
    expect(recovery.getState().pending).toHaveLength(0)
  })

  it('recovers pending exports and retry deadlines after restart', async () => {
    const first = service()
    await first.load()
    upload.mockRejectedValueOnce(failure(503))
    await first.enqueue(file)
    await first.drain()
    await first.close()
    const second = service()
    await second.load()
    await second.drain()
    expect(upload).toHaveBeenCalledTimes(1)
    now += 30_000
    await second.drain()
    expect(upload).toHaveBeenCalledTimes(2)
    expect(second.getState().pending).toHaveLength(0)
  })

  it('backs off transient failures at 30s, 60s, 120s, 240s, then caps at 300s', async () => {
    const recovery = service()
    await recovery.load()
    upload.mockRejectedValue(failure(null))
    await recovery.enqueue(file)
    for (const milliseconds of [30_000, 60_000, 120_000, 240_000, 300_000, 300_000]) {
      await recovery.drain()
      expect(recovery.getState().pending[0]?.nextAttemptAt).toBe(new Date(now + milliseconds).toISOString())
      expect([...timers.values()]).toContain(now + milliseconds)
      now += milliseconds
    }
    expect(upload).toHaveBeenCalledTimes(6)
  })

  it.each([408, 425, 429, 500, 502, 503, 504])('retries transient HTTP %i and honors a longer Retry-After', async (status) => {
    const recovery = service()
    await recovery.load()
    upload.mockRejectedValueOnce(failure(status, 900_000))
    await recovery.enqueue(file)
    await recovery.drain()
    expect(recovery.getState().pending[0]?.nextAttemptAt).toBe(new Date(now + 900_000).toISOString())
    now += 900_000
    await recovery.drain()
    expect(recovery.getState().pending).toHaveLength(0)
  })

  it.each([401, 403])('pauses all queued sends on HTTP %i until sign-in resumes', async (status) => {
    const recovery = service()
    await recovery.load()
    upload.mockRejectedValueOnce(failure(status))
    await recovery.enqueue(file)
    await recovery.enqueue(path.join(directory, 'other', 'Everlook.lua'))
    await recovery.drain()
    expect(upload).toHaveBeenCalledTimes(1)
    expect(recovery.getState().pending.every((entry) => entry.status === 'auth-required')).toBe(true)
    now += 3_600_000
    await recovery.retry(file)
    await recovery.drain()
    expect(upload).toHaveBeenCalledTimes(1)
    await recovery.resume()
    expect(upload).toHaveBeenCalledTimes(2)
    expect(recovery.getState().pending[0]?.status).toBe('blocked')
  })

  it('pauses the queue when the account still needs a passkey or authenticator', async () => {
    const recovery = service()
    await recovery.load()
    const other = path.join(directory, 'Other.lua')
    await writeFile(other, 'EverlookDB = {}')
    upload.mockRejectedValueOnce(Object.assign(new Error('Upload failed'), {
      name: 'UploadError', httpStatus: 403, code: 'security_required', setupUrl: 'https://everlook.ing/account/security'
    }))
    await recovery.enqueue(file)
    await recovery.enqueue(other)
    await recovery.drain()
    expect(upload).toHaveBeenCalledTimes(1)
    expect(recovery.getState().pending.every((entry) => entry.status === 'security-required')).toBe(true)
    expect(recovery.getState().pending[0]?.error).toBe('Finish securing your account on everlook.ing to resume uploads.')
    expect(recovery.getState().pending[0]?.setupUrl).toBe('https://everlook.ing/account/security')
    now += 3_600_000
    await recovery.resume()
    await recovery.drain()
    expect(upload).toHaveBeenCalledTimes(1)
    await recovery.releaseSecurity()
    expect(upload).toHaveBeenCalledTimes(3)
    expect(recovery.getState().pending).toHaveLength(0)
  })

  it('pauses the queue when contributions were revoked', async () => {
    const recovery = service()
    await recovery.load()
    const other = path.join(directory, 'Other.lua')
    await writeFile(other, 'EverlookDB = {}')
    upload.mockRejectedValueOnce(Object.assign(new Error('Upload failed'), {
      name: 'UploadError', httpStatus: 403, code: 'contributions_revoked'
    }))
    await recovery.enqueue(file)
    await recovery.enqueue(other)
    await recovery.drain()
    expect(upload).toHaveBeenCalledTimes(1)
    expect(recovery.getState().pending.every((entry) => entry.status === 'contributions-revoked')).toBe(true)
    expect(recovery.getState().pending[0]?.error).toBe('Contributions from this account were revoked.')
    expect(recovery.getState().pending[0]?.setupUrl).toBeNull()
    await recovery.resume()
    await recovery.drain()
    expect(upload).toHaveBeenCalledTimes(1)
    expect(recovery.getState().pending.every((entry) => entry.status === 'contributions-revoked')).toBe(true)
  })

  it('keeps a plain 403 on the sign-in path', async () => {
    const recovery = service()
    await recovery.load()
    upload.mockRejectedValueOnce(Object.assign(failure(403), { code: 'quota_exceeded' }))
    await recovery.enqueue(file)
    await recovery.drain()
    expect(recovery.getState().pending[0]?.status).toBe('auth-required')
  })

  it.each([400, 404, 413, 422])('keeps HTTP %i visible without automatic retry; manual retry succeeds', async (status) => {
    const recovery = service()
    await recovery.load()
    upload.mockRejectedValueOnce(failure(status))
    await recovery.enqueue(file)
    await recovery.drain()
    expect(recovery.getState().pending[0]?.status).toBe('blocked')
    expect(timers.size).toBe(0)
    now += 3_600_000
    await recovery.drain()
    expect(upload).toHaveBeenCalledTimes(1)
    await recovery.retry(file)
    await recovery.drain()
    expect(upload).toHaveBeenCalledTimes(2)
  })

  it('keeps missing files for manual retry and cancels removed files across scopes', async () => {
    const recovery = service()
    await recovery.load()
    await rm(file)
    await recovery.enqueue(file)
    await recovery.drain()
    expect(upload).not.toHaveBeenCalled()
    expect(recovery.getState().pending[0]?.status).toBe('blocked')
    expect(recovery.getState().history[0]?.outcome).toBe('error')
    await writeFile(file, 'EverlookDB = {}')
    await recovery.retry(file)
    await recovery.drain()
    expect(upload).toHaveBeenCalledTimes(1)
    await recovery.enqueue(file)
    context = { origin: 'https://other.test', accountId: 2 }
    await recovery.enqueue(file)
    await recovery.remove(file)
    expect(recovery.getState().pending).toHaveLength(0)
    context = { origin: 'https://everlook.test', accountId: 1 }
    expect(recovery.getState().pending).toHaveLength(0)
  })

  it('isolates origins and authenticated accounts, including ingest verdicts', async () => {
    const recovery = service()
    await recovery.load()
    await recovery.enqueue(file)
    context = { origin: 'https://everlook.test', accountId: 2 }
    expect(recovery.getState()).toEqual({ pending: [], history: [] })
    await recovery.drain()
    expect(upload).not.toHaveBeenCalled()
    await recovery.enqueue(file)
    await recovery.drain()
    await recovery.updateIngest(result().hash, { id: 42, status: 'completed', signed: 'signed', error: null })
    expect(recovery.getState().history[0]?.signed).toBe('signed')
    context = { origin: 'https://other.test', accountId: 2 }
    expect(recovery.getState()).toEqual({ pending: [], history: [] })
    context = { origin: 'https://everlook.test/', accountId: 1 }
    expect(recovery.getState().pending).toHaveLength(1)
    expect(recovery.getState().history).toHaveLength(0)
    await recovery.drain()
    expect(recovery.getState().history[0]?.ingestStatus).toBe('pending')
    context = null
    expect(recovery.getState()).toEqual({ pending: [], history: [] })
  })

  it('aborts paused active sends, retains pending, and does not log an old-account error', async () => {
    const recovery = service()
    const started = deferred<void>()
    upload.mockImplementationOnce(async (_file, _force, signal) => {
      started.resolve()
      return new Promise<UploadResult>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
      })
    })
    await recovery.load()
    await recovery.enqueue(file)
    const draining = recovery.drain()
    await started.promise
    recovery.pause()
    context = { origin: 'https://everlook.test', accountId: 2 }
    await draining
    expect(recovery.getState().history).toHaveLength(0)
    context = { origin: 'https://everlook.test', accountId: 1 }
    expect(recovery.getState().pending).toHaveLength(1)
    expect(recovery.getState().history).toHaveLength(0)
    await recovery.resume()
    expect(upload).toHaveBeenCalledTimes(2)
  })

  it('ignores a stale successful send after removal and abort', async () => {
    const recovery = service()
    const active = deferred<UploadResult>()
    const started = deferred<void>()
    upload.mockImplementationOnce(async () => { started.resolve(); return active.promise })
    await recovery.load()
    await recovery.enqueue(file)
    const draining = recovery.drain()
    await started.promise
    await recovery.remove(file)
    active.resolve(result())
    await draining
    expect(recovery.getState()).toEqual({ pending: [], history: [] })
  })

  it('updates matching history with failed ingest without pretending the transfer failed', async () => {
    const recovery = service()
    await recovery.load()
    await recovery.enqueue(file)
    await recovery.drain()
    await recovery.updateIngest(result().hash, { id: 42, status: 'failed', signed: null, error: 'Invalid world data' })
    expect(recovery.getState().history[0]).toMatchObject({ outcome: 'uploaded', ingestStatus: 'failed', error: 'Invalid world data', signed: null })
    expect(recovery.getState().pending).toHaveLength(0)
  })

  it('returns immutable snapshots and normalizes the scope origin', async () => {
    const recovery = service()
    await recovery.load()
    await recovery.enqueue(file)
    const snapshot = recovery.getState()
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.pending)).toBe(true)
    expect(Object.isFrozen(snapshot.pending[0])).toBe(true)
    expect(uploadScope({ origin: 'https://everlook.test/some/path/', accountId: 1 })).toBe('https://everlook.test|1')
  })

  it('retains only the last 200 history entries per scope across files and restarts', async () => {
    const recovery = service()
    await recovery.load()
    for (let index = 0; index < 203; index += 1) {
      now += 1
      await recovery.enqueue(index % 2 === 0 ? file : path.join(directory, 'missing', 'Everlook.lua'))
      await recovery.drain()
    }
    expect(recovery.getState().history).toHaveLength(200)
    await recovery.close()
    const reopened = service()
    await reopened.load()
    expect(reopened.getState().history).toHaveLength(200)
    expect(reopened.getState().history[0]?.at).toBe(new Date(now).toISOString())
  })

  it('repairs an insecure leftover temporary file before writing metadata', async () => {
    const temporary = path.join(directory, 'upload-recovery.json.tmp')
    await writeFile(temporary, 'interrupted write')
    await chmod(temporary, 0o644)
    const recovery = service()
    await recovery.load()
    await recovery.enqueue(file)
    if (process.platform !== 'win32') expect((await stat(path.join(directory, 'upload-recovery.json'))).mode & 0o777).toBe(0o600)
  })

  it('recovers a send interrupted after its pending record was written', async () => {
    const recovery = service()
    await recovery.load()
    await recovery.enqueue(file)
    await recovery.close()
    const filename = path.join(directory, 'upload-recovery.json')
    const persisted = JSON.parse(await readFile(filename, 'utf8'))
    persisted.pending[0].status = 'uploading'
    await writeFile(filename, JSON.stringify(persisted))
    const restarted = service()
    await restarted.load()
    expect(restarted.getState().pending[0]?.status).toBe('queued')
    await restarted.drain()
    expect(upload).toHaveBeenCalledTimes(1)
  })

  it('loads a queue file whose status is no longer known', async () => {
    const recovery = service()
    await recovery.load()
    await recovery.enqueue(file)
    await recovery.close()
    const filename = path.join(directory, 'upload-recovery.json')
    const persisted = JSON.parse(await readFile(filename, 'utf8')) as { pending: Array<Record<string, unknown>> }
    persisted.pending[0]!.status = 'needs-review'
    delete persisted.pending[0]!.setupUrl
    await writeFile(filename, JSON.stringify(persisted))
    const restarted = service()
    await restarted.load()
    expect(restarted.getState().pending[0]?.status).toBe('queued')
    await restarted.drain()
    expect(upload).toHaveBeenCalledTimes(1)
  })

  it('keeps a reloaded security hold paused', async () => {
    const recovery = service()
    await recovery.load()
    await recovery.enqueue(file)
    await recovery.close()
    const filename = path.join(directory, 'upload-recovery.json')
    const persisted = JSON.parse(await readFile(filename, 'utf8')) as { pending: Array<Record<string, unknown>> }
    persisted.pending[0]!.status = 'security-required'
    persisted.pending[0]!.error = 'Finish securing your account on everlook.ing to resume uploads.'
    persisted.pending[0]!.setupUrl = 'https://everlook.ing/account/security'
    await writeFile(filename, JSON.stringify(persisted))
    const restarted = service()
    await restarted.load()
    await restarted.drain()
    expect(upload).not.toHaveBeenCalled()
    expect(restarted.getState().pending[0]?.status).toBe('security-required')
    expect(restarted.getState().pending[0]?.setupUrl).toBe('https://everlook.ing/account/security')
  })

  it('runs scheduled retries automatically with a deterministic timer', async () => {
    const recovery = service()
    await recovery.load()
    upload.mockRejectedValueOnce(failure(503))
    await recovery.enqueue(file)
    await recovery.drain()
    now += 30_000
    for (const [callback, due] of [...timers]) {
      if (due <= now) { timers.delete(callback); callback() }
    }
    await recovery.drain()
    expect(upload).toHaveBeenCalledTimes(2)
    expect(recovery.getState().pending).toHaveLength(0)
  })

  it('keeps generic permanent errors blocked and does not persist their contents', async () => {
    const recovery = service()
    await recovery.load()
    upload.mockRejectedValueOnce(new Error('malformed Lua secret token=do-not-store https://storage.test/signature=do-not-store'))
    await recovery.enqueue(file)
    await recovery.drain()
    expect(recovery.getState().pending[0]?.status).toBe('blocked')
    expect(await readFile(path.join(directory, 'upload-recovery.json'), 'utf8')).not.toContain('do-not-store')
  })

  it('serializes distinct file uploads even when drain is called concurrently', async () => {
    const other = path.join(directory, 'Other.lua')
    await writeFile(other, 'EverlookDB = {}')
    const recovery = service()
    const started = deferred<void>()
    const active = deferred<UploadResult>()
    upload.mockImplementationOnce(async () => { started.resolve(); return active.promise })
    await recovery.load()
    await recovery.enqueue(file)
    await recovery.enqueue(other)
    const first = recovery.drain()
    const second = recovery.drain()
    await started.promise
    expect(upload).toHaveBeenCalledTimes(1)
    active.resolve(result())
    await Promise.all([first, second])
    expect(upload).toHaveBeenCalledTimes(2)
  })

  it('does not undo a newer pause while resume is awaiting load', async () => {
    const recovery = service()
    recovery.pause()
    const resuming = recovery.resume()
    recovery.pause()
    await resuming
    await recovery.enqueue(file)
    await recovery.drain()
    expect(upload).not.toHaveBeenCalled()
    await recovery.resume()
    expect(upload).toHaveBeenCalledTimes(1)
  })

  it('rejects a stale enqueue when the authenticated account changes during initial load', async () => {
    const recovery = service()
    const enqueueing = recovery.enqueue(file)
    context = { origin: 'https://other.test', accountId: 2 }
    await expect(enqueueing).rejects.toMatchObject({ name: 'AbortError' })
    expect(recovery.getState().pending).toHaveLength(0)
    context = { origin: 'https://everlook.test', accountId: 1 }
    expect(recovery.getState().pending).toHaveLength(0)
  })

  it('ignores an ingest verdict when the account changes while initial load is in flight', async () => {
    const first = service()
    await first.load()
    await first.enqueue(file)
    await first.drain()
    context = { origin: 'https://other.test', accountId: 2 }
    await first.enqueue(file)
    await first.drain()
    await first.close()
    context = { origin: 'https://everlook.test', accountId: 1 }
    const restarted = service()
    const updating = restarted.updateIngest(result().hash, { id: 42, status: 'completed', signed: 'signed', error: null })
    context = { origin: 'https://other.test', accountId: 2 }
    await updating
    expect(restarted.getState().history[0]?.signed).toBeNull()
    context = { origin: 'https://everlook.test', accountId: 1 }
    expect(restarted.getState().history[0]?.signed).toBeNull()
  })

  it('retries when the world file is still being written', async () => {
    const recovery = service()
    await recovery.load()
    upload.mockRejectedValueOnce(Object.assign(
      new Error('Everlook.lua is still changing. Everlook will try again after it settles.'),
      { code: UNSTABLE_WORLD_FILE_CODE }
    ))
    await recovery.enqueue(file)
    await recovery.drain()
    expect(recovery.getState().pending[0]?.status).toBe('retrying')
    expect(recovery.getState().pending[0]?.error).toBe('Everlook.lua is still changing. Everlook will try again after it settles.')
    expect(timers.size).toBe(1)
    now += 30_000
    await recovery.drain()
    expect(upload).toHaveBeenCalledTimes(2)
    expect(recovery.getState().pending).toHaveLength(0)
  })

  it('retries a network failure even if the last successful HTTP exchange was 202', async () => {
    const recovery = service()
    await recovery.load()
    upload.mockRejectedValueOnce(new UploadError('Could not send object.', result().responses, {
      cause: new TypeError('fetch failed')
    }))
    await recovery.enqueue(file)
    await recovery.drain()
    expect(recovery.getState().pending[0]?.status).toBe('retrying')
    expect(recovery.getState().pending[0]?.nextAttemptAt).toBe(new Date(now + 30_000).toISOString())
  })
})
