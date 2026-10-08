import { describe, expect, it } from 'vitest'
import { isTrustedIpcSender } from './ipc-trust'

const dev = { packaged: false, rendererUrl: 'http://localhost:5173' }
const packaged = { packaged: true, rendererUrl: undefined }

describe('isTrustedIpcSender', () => {
  it('trusts a packaged window only when it is a file URL', () => {
    expect(isTrustedIpcSender('file:///usr/lib/everlook/app.asar/out/renderer/index.html', packaged)).toBe(true)
    expect(isTrustedIpcSender('http://localhost:5173/', packaged)).toBe(false)
    expect(isTrustedIpcSender('https://everlook.ing/', packaged)).toBe(false)
  })

  it('trusts an unpackaged window only when it matches the dev server origin', () => {
    expect(isTrustedIpcSender('http://localhost:5173/index.html', dev)).toBe(true)
    expect(isTrustedIpcSender('http://localhost:5174/', dev)).toBe(false)
    expect(isTrustedIpcSender('file:///tmp/index.html', dev)).toBe(false)
    expect(isTrustedIpcSender('http://localhost:5173/', { packaged: false, rendererUrl: undefined })).toBe(false)
  })

  it('rejects a sender or dev server URL that cannot be parsed', () => {
    expect(isTrustedIpcSender('not a url', dev)).toBe(false)
    expect(isTrustedIpcSender('http://localhost:5173/', { packaged: false, rendererUrl: 'not a url' })).toBe(false)
    expect(isTrustedIpcSender('', packaged)).toBe(false)
  })
})
