import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { DesktopIdentityError, fetchDesktopIdentity, SECURITY_HOLD_POLL_MS, shouldReleaseSecurityHold } from './desktop-identity'

const origin = 'https://everlook.test'
const credential = 'a'.repeat(64)

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => { resolve = yes })
  return { promise, resolve }
}

function identityReply(body: unknown = { id: 42, name: 'Test account' }): Response {
  return new Response(JSON.stringify(body))
}

describe('fetchDesktopIdentity', () => {
  it('returns a validated account and credential hash using exactly the captured origin', async () => {
    const token = vi.fn(async () => credential)
    const controller = new AbortController()
    const request = vi.fn<typeof fetch>(async () => identityReply())
    const identity = await fetchDesktopIdentity({ origin, token, signal: controller.signal, request })
    expect(identity).toEqual({ id: 42, name: 'Test account', tokenHash: createHash('sha256').update(credential).digest('hex') })
    expect(request).toHaveBeenCalledTimes(1)
    const [url, init] = request.mock.calls[0]!
    expect(url).toBe('https://everlook.test/api/desktop/me')
    expect(init?.headers).toEqual({ Authorization: `Bearer ${credential}`, Accept: 'application/json' })
    expect(init?.signal).toBeInstanceOf(AbortSignal)
    expect(JSON.stringify(identity)).not.toContain(credential)
  })

  it('accepts an identity that omits security and carries security when the server sends it', async () => {
    const controller = new AbortController()
    const request = vi.fn<typeof fetch>(async () => identityReply())
    const plain = await fetchDesktopIdentity({ origin, token: async () => credential, signal: controller.signal, request })
    expect(plain).toEqual({ id: 42, name: 'Test account', tokenHash: createHash('sha256').update(credential).digest('hex') })
    expect(plain).not.toHaveProperty('security')
    request.mockResolvedValueOnce(identityReply({
      id: 42,
      name: 'Test account',
      security: { ready: false, missing: ['passkey', 'totp'], setup_url: 'https://everlook.test/account/security' }
    }))
    const reported = await fetchDesktopIdentity({ origin, token: async () => credential, signal: new AbortController().signal, request })
    expect(reported?.security).toEqual({ ready: false, missing: ['passkey', 'totp'], setup_url: 'https://everlook.test/account/security' })
    expect(shouldReleaseSecurityHold({ security: { ready: true } })).toBe(true)
    expect(shouldReleaseSecurityHold({ security: { ready: false } })).toBe(false)
    expect(shouldReleaseSecurityHold({})).toBe(false)
    expect(SECURITY_HOLD_POLL_MS).toBe(60_000)
  })

  it('never sends a stale credential if cancellation occurs during a slow token lookup', async () => {
    const lookup = deferred<string | null>()
    const controller = new AbortController()
    const request = vi.fn<typeof fetch>()
    const fetching = fetchDesktopIdentity({ origin, token: () => lookup.promise, signal: controller.signal, request })
    controller.abort()
    lookup.resolve(credential)
    await expect(fetching).rejects.toMatchObject({ name: 'AbortError' })
    expect(request).not.toHaveBeenCalled()
  })

  it('never returns an old account if cancellation occurs while reading the response body', async () => {
    const body = deferred<unknown>()
    const reading = deferred<void>()
    const controller = new AbortController()
    const response = identityReply()
    vi.spyOn(response, 'json').mockImplementation(async () => { reading.resolve(); return body.promise })
    const request = vi.fn<typeof fetch>(async () => response)
    const fetching = fetchDesktopIdentity({ origin, token: async () => credential, signal: controller.signal, request })
    await reading.promise
    controller.abort()
    body.resolve({ id: 42, name: 'Old account' })
    await expect(fetching).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('checks cancellation after a late HTTP response before classifying its status', async () => {
    const controller = new AbortController()
    const request = vi.fn<typeof fetch>(async () => {
      controller.abort()
      return new Response('', { status: 401 })
    })
    await expect(fetchDesktopIdentity({ origin, token: async () => credential, signal: controller.signal, request }))
      .rejects.toMatchObject({ name: 'AbortError' })
  })

  it('does not fetch without a token', async () => {
    const request = vi.fn<typeof fetch>()
    expect(await fetchDesktopIdentity({ origin, token: async () => null, signal: new AbortController().signal, request })).toBeNull()
    expect(request).not.toHaveBeenCalled()
  })

  it('does not read credentials or fetch when already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const token = vi.fn(async () => credential)
    const request = vi.fn<typeof fetch>()
    await expect(fetchDesktopIdentity({ origin, token, signal: controller.signal, request })).rejects.toMatchObject({ name: 'AbortError' })
    expect(token).not.toHaveBeenCalled()
    expect(request).not.toHaveBeenCalled()
  })

  it.each([401, 403, 429, 503])('throws a typed HTTP %i failure without returning a stale identity', async (httpStatus) => {
    const request = vi.fn<typeof fetch>(async () => new Response('secret response payload', { status: httpStatus }))
    const fetching = fetchDesktopIdentity({ origin, token: async () => credential, signal: new AbortController().signal, request })
    await expect(fetching).rejects.toBeInstanceOf(DesktopIdentityError)
    await expect(fetching).rejects.toMatchObject({ httpStatus })
    await expect(fetching).rejects.not.toMatchObject({ message: expect.stringContaining('secret response') })
  })

  it.each([
    { user: { id: 42, name: 'Nested account' } },
    { id: '42', name: 'String ID' },
    { id: 0, name: 'Zero ID' },
    { id: 1.5, name: 'Fractional ID' },
    { id: 42, name: null },
    { id: 42 },
    null
  ])('rejects an invalid top-level identity: %j', async (body) => {
    const request = vi.fn<typeof fetch>(async () => identityReply(body))
    await expect(fetchDesktopIdentity({ origin, token: async () => credential, signal: new AbortController().signal, request })).rejects.toThrow()
  })

  it('does not swallow network failures as a signed-out session', async () => {
    const error = new TypeError('Network unavailable')
    const request = vi.fn<typeof fetch>(async () => { throw error })
    await expect(fetchDesktopIdentity({ origin, token: async () => credential, signal: new AbortController().signal, request })).rejects.toBe(error)
  })
})
