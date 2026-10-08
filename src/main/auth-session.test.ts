import { describe, expect, it } from 'vitest'
import { AuthSession, CUSTOM_SCHEME_REDIRECT_URI, LINUX_WM_CLASS, PROTOCOL_SCHEME } from './auth-session'

function callback(
  urlValue: string,
  code = 'a'.repeat(64),
  stateOverride?: string,
  redirectUri = CUSTOM_SCHEME_REDIRECT_URI
): string {
  const authorization = new URL(urlValue)
  const state = stateOverride ?? authorization.searchParams.get('state')
  return `${redirectUri}?code=${code}&state=${state}`
}

describe('desktop identity', () => {
  it('registers the Everlook protocol and Linux window class', () => {
    expect(PROTOCOL_SCHEME).toBe('everlook')
    expect(LINUX_WM_CLASS).toBe('dev.csfh.everlook')
    expect(CUSTOM_SCHEME_REDIRECT_URI).toBe('everlook://auth/callback')
  })
})

describe('AuthSession', () => {
  it('accepts one matching custom-scheme callback', () => {
    const session = new AuthSession()
    const pending = session.begin('https://everlook.example', CUSTOM_SCHEME_REDIRECT_URI, 1_000)
    expect(new URL(pending.url).searchParams.get('redirect_uri')).toBe(CUSTOM_SCHEME_REDIRECT_URI)
    expect(session.consume(callback(pending.url), 2_000)).toEqual({
      code: 'a'.repeat(64),
      verifier: pending.verifier,
      redirectUri: CUSTOM_SCHEME_REDIRECT_URI
    })
    expect(() => session.consume(callback(pending.url), 2_000)).toThrow(/invalid or expired/)
  })

  it('accepts one matching loopback callback', () => {
    const session = new AuthSession()
    const redirectUri = 'http://127.0.0.1:43100/callback'
    const pending = session.begin('https://everlook.example', redirectUri, 1_000)
    expect(session.consume(callback(pending.url, 'b'.repeat(64), undefined, redirectUri), 2_000)).toEqual({
      code: 'b'.repeat(64),
      verifier: pending.verifier,
      redirectUri
    })
  })

  it('rejects state mismatch, expiry, and unexpected callback paths', () => {
    const session = new AuthSession()
    const pending = session.begin('https://everlook.example', CUSTOM_SCHEME_REDIRECT_URI, 1_000)
    expect(() => session.consume(callback(pending.url, 'a'.repeat(64), 'wrong'), 2_000)).toThrow()
    expect(() => session.consume(callback(pending.url), 302_000)).toThrow()

    const another = new AuthSession()
    const active = another.begin('https://everlook.example', CUSTOM_SCHEME_REDIRECT_URI, 1_000)
    expect(() =>
      another.consume(callback(active.url).replace('/callback', '/unexpected'), 2_000)
    ).toThrow(/invalid or expired/)
  })
})
