import { afterEach, describe, expect, it } from 'vitest'
import { startAuthCallbackServer, type AuthCallbackListener } from './auth-callback-server'

const listeners: AuthCallbackListener[] = []

afterEach(async () => {
  await Promise.all(listeners.splice(0).map((listener) => listener.close()))
})

describe('auth callback server', () => {
  it('listens on loopback and returns the callback URL', async () => {
    const listener = await startAuthCallbackServer()
    listeners.push(listener)

    expect(listener.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/)

    const code = 'a'.repeat(64)
    const state = 'b'.repeat(32)
    const waiting = listener.waitForCallback(2_000)
    const response = await fetch(`${listener.redirectUri}?code=${code}&state=${state}`)
    const body = await response.text()

    expect(response.status).toBe(200)
    expect(body).toContain('You can close this tab')
    await expect(waiting).resolves.toBe(`${listener.redirectUri}?code=${code}&state=${state}`)
  })

  it('times out with a message about the browser', async () => {
    const listener = await startAuthCallbackServer()
    listeners.push(listener)
    await expect(listener.waitForCallback(20)).rejects.toThrow(
      'Timed out waiting for the browser to finish signing in.'
    )
  })

  it('rejects unknown paths', async () => {
    const listener = await startAuthCallbackServer()
    listeners.push(listener)
    const origin = new URL(listener.redirectUri).origin
    const response = await fetch(`${origin}/other`)
    expect(response.status).toBe(404)
  })
})
