import { describe, expect, it, vi } from 'vitest'
import { waitForIngest } from './upload-status'

const hash = 'a'.repeat(64)

function reply(status: number, upload?: { status: string; signed: boolean }): Response {
  return new Response(JSON.stringify(upload ? { upload } : {}), { status })
}

function ingestReply(status: string, signed = false, error: string | null = null): Response {
  return new Response(JSON.stringify({ upload: { id: 42, status, signed, error } }))
}

function ingestRun(responses: Array<Response | Error>, extra: Partial<Parameters<typeof waitForIngest>[0]> = {}) {
  const request = vi.fn<typeof fetch>(async () => {
    const next = responses.shift() ?? reply(404)
    if (next instanceof Error) throw next
    return next
  })
  const sleep = vi.fn(async () => undefined)
  const onStatus = vi.fn(async () => undefined)
  const result = waitForIngest({
    baseUrl: 'https://everlook.test/', token: 'desktop', sha256: hash,
    request, sleep, onStatus, attempts: 5, intervalMs: 1, ...extra
  })
  return { result, request, sleep, onStatus }
}

describe('waitForIngest', () => {
  it('reports intermediate ingest states and waits through processing until completed', async () => {
    const { result, request, onStatus } = ingestRun([
      ingestReply('pending'), ingestReply('parsing'), ingestReply('processing', true), ingestReply('completed', true)
    ])
    expect(await result).toEqual({ id: 42, status: 'completed', signed: 'signed', error: null })
    expect(request).toHaveBeenCalledTimes(4)
    expect(onStatus.mock.calls).toEqual([
      [{ id: 42, status: 'pending', signed: null, error: null }],
      [{ id: 42, status: 'parsing', signed: null, error: null }],
      [{ id: 42, status: 'processing', signed: 'signed', error: null }],
      [{ id: 42, status: 'completed', signed: 'signed', error: null }]
    ])
    expect(request.mock.calls[0]?.[0]).toBe(`https://everlook.test/api/desktop/addon/uploads/${hash}`)
  })

  it('returns failed ingest with its safe API error after processing', async () => {
    const { result } = ingestRun([
      ingestReply('processing', false), ingestReply('failed', false, 'This world file could not be processed.')
    ])
    expect(await result).toEqual({ id: 42, status: 'failed', signed: null, error: 'This world file could not be processed.' })
  })

  it('returns a rejected upload as a terminal verdict', async () => {
    expect(await ingestRun([ingestReply('rejected')]).result).toEqual({ id: 42, status: 'rejected', signed: null, error: null })
  })

  it('retries transient responses, temporary 404, malformed data, and network errors', async () => {
    const { result, request } = ingestRun([
      new Error('offline'), reply(503), reply(404), new Response('invalid JSON'), ingestReply('completed')
    ])
    expect(await result).toEqual({ id: 42, status: 'completed', signed: 'unsigned', error: null })
    expect(request).toHaveBeenCalledTimes(5)
  })

  it.each([401, 403, 400, 422])('stops after permanent HTTP %i', async (status) => {
    const { result, request } = ingestRun([reply(status), ingestReply('completed')])
    expect(await result).toBeNull()
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('gives no completed verdict when processing remains unfinished', async () => {
    const { result, request, onStatus } = ingestRun(Array.from({ length: 5 }, () => ingestReply('processing', true)))
    expect(await result).toBeNull()
    expect(request).toHaveBeenCalledTimes(5)
    expect(onStatus).toHaveBeenCalledTimes(1)
  })

  it('does not issue a request when its account context is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const { result, request } = ingestRun([ingestReply('completed')], { signal: controller.signal })
    expect(await result).toBeNull()
    expect(request).not.toHaveBeenCalled()
  })

  it('ignores a late response after its account context changes', async () => {
    const controller = new AbortController()
    const onStatus = vi.fn()
    const request = vi.fn<typeof fetch>(async () => {
      controller.abort()
      return ingestReply('completed', true)
    })
    expect(await waitForIngest({
      baseUrl: 'https://everlook.test', token: 'desktop', sha256: hash,
      request, onStatus, signal: controller.signal, attempts: 1
    })).toBeNull()
    expect(onStatus).not.toHaveBeenCalled()
  })

  it('interrupts polling sleep when the account context changes', async () => {
    vi.useFakeTimers()
    try {
      const controller = new AbortController()
      const onStatus = vi.fn(() => { controller.abort() })
      const { result, request } = ingestRun([ingestReply('processing'), ingestReply('completed')], {
        signal: controller.signal, onStatus, sleep: undefined, intervalMs: 3000
      })
      expect(await result).toBeNull()
      expect(request).toHaveBeenCalledTimes(1)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not swallow history persistence errors from the status callback', async () => {
    const error = new Error('Disk is full')
    const { result } = ingestRun([ingestReply('completed')], { onStatus: async () => { throw error } })
    await expect(result).rejects.toBe(error)
  })

  it('validates id, signed, and status before reporting a verdict', async () => {
    const invalid = [
      { id: 'not-an-id', status: 'completed', signed: true },
      { id: 42, status: false, signed: true },
      { id: 42, status: 'completed', signed: 'true' },
      { status: 'completed', signed: true }
    ]
    const { result, onStatus } = ingestRun(invalid.map((upload) => new Response(JSON.stringify({ upload }))), { attempts: 4 })
    expect(await result).toBeNull()
    expect(onStatus).not.toHaveBeenCalled()
  })
})
