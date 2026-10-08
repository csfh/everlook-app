import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

export const PROTOCOL_SCHEME = 'everlook'
export const LINUX_WM_CLASS = 'dev.csfh.everlook'
export const CUSTOM_SCHEME_REDIRECT_URI = `${PROTOCOL_SCHEME}://auth/callback`

type PendingAuthorization = {
  state: string
  verifier: string
  redirectUri: string
  expiresAt: number
  consumed: boolean
}

function base64Url(value: Buffer): string {
  return value.toString('base64url')
}

function equal(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left)
  const rightBuffer = Buffer.from(right)
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer)
}

function callbackMatches(callback: URL, redirectUri: string): boolean {
  const expected = new URL(redirectUri)
  return (
    callback.protocol === expected.protocol &&
    callback.hostname === expected.hostname &&
    callback.port === expected.port &&
    callback.pathname === expected.pathname
  )
}

export class AuthSession {
  private pending: PendingAuthorization | null = null

  begin(baseUrl: string, redirectUri: string, now = Date.now()): { url: string; verifier: string } {
    const state = base64Url(randomBytes(32))
    const verifier = base64Url(randomBytes(48))
    const challenge = base64Url(createHash('sha256').update(verifier).digest())
    this.pending = { state, verifier, redirectUri, expiresAt: now + 5 * 60_000, consumed: false }

    const url = new URL('/desktop/authorize', baseUrl)
    url.search = new URLSearchParams({
      client_id: 'everlook-desktop',
      redirect_uri: redirectUri,
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256'
    }).toString()

    return { url: url.toString(), verifier }
  }

  consume(callback: string, now = Date.now()): { code: string; verifier: string; redirectUri: string } {
    const url = new URL(callback)
    const pending = this.pending
    const state = url.searchParams.get('state')
    const code = url.searchParams.get('code')
    if (
      pending === null ||
      pending.consumed ||
      pending.expiresAt < now ||
      !callbackMatches(url, pending.redirectUri) ||
      state === null ||
      !equal(state, pending.state) ||
      code === null ||
      !/^[a-fA-F0-9]{64}$/.test(code)
    ) {
      throw new Error('The authorization callback is invalid or expired.')
    }

    pending.consumed = true
    return { code, verifier: pending.verifier, redirectUri: pending.redirectUri }
  }

  clear(): void {
    this.pending = null
  }
}
