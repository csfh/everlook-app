import { describe, expect, it } from 'vitest'
import { boundedRequest, retryAfterMilliseconds } from './request'

describe('bounded requests', () => {
  it('terminates a stalled request at its deadline', async () => {
    const stalled: typeof fetch = async (_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
    })
    const keepAlive = setTimeout(() => undefined, 1000)
    try {
      await expect(boundedRequest(stalled, 'https://example.test', {}, { timeoutMs: 10 })).rejects.toThrow()
    } finally { clearTimeout(keepAlive) }
  })
  it('propagates account or shutdown cancellation', async () => {
    const controller = new AbortController()
    controller.abort(new Error('Session changed'))
    await expect(boundedRequest(fetch, 'https://example.test', {}, { signal: controller.signal })).rejects.toThrow('Session changed')
  })
  it('parses retry delays and dates without accepting invalid values', () => {
    expect(retryAfterMilliseconds('30', 0)).toBe(30000)
    expect(retryAfterMilliseconds('Thu, 01 Jan 1970 00:01:00 GMT', 0)).toBe(60000)
    expect(retryAfterMilliseconds('bad', 0)).toBeNull()
    expect(retryAfterMilliseconds('-1', 0)).toBeNull()
  })
})
