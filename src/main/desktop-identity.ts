import { createHash } from 'node:crypto'
import { z } from 'zod'
import { boundedRequest } from './request'

export class DesktopIdentityError extends Error {
  constructor(readonly httpStatus: number) {
    super(httpStatus === 401
      ? 'Your Everlook session expired. Sign in again.'
      : httpStatus === 403
        ? 'Everlook denied access to this account. Sign in again.'
        : `Everlook could not verify this account (HTTP ${httpStatus}).`)
    this.name = 'DesktopIdentityError'
  }
}

const securitySchema = z.object({
  ready: z.boolean(),
  missing: z.array(z.enum(['email', 'passkey', 'totp'])),
  setup_url: z.string()
})

const identitySchema = z.object({
  id: z.number().int().positive(),
  name: z.string(),
  security: securitySchema.optional()
})

export const SECURITY_HOLD_POLL_MS = 60_000

export type DesktopSecurity = z.infer<typeof securitySchema>

export type DesktopIdentity = { id: number; name: string; tokenHash: string; security?: DesktopSecurity }

/** True only when the server says the account can upload. A missing security object stays held. */
export function shouldReleaseSecurityHold(identity: { security?: { ready: boolean } | undefined }): boolean {
  return identity.security?.ready === true
}

/** The caller captures the origin and session signal before invoking this function. */
export async function fetchDesktopIdentity(options: {
  origin: string
  token: () => Promise<string | null>
  signal: AbortSignal
  request?: typeof fetch
}): Promise<DesktopIdentity | null> {
  const { origin, signal } = options
  signal.throwIfAborted()
  const token = await options.token()
  signal.throwIfAborted()
  if (token === null) return null

  const response = await boundedRequest(options.request ?? fetch,
    `${new URL(origin).origin}/api/desktop/me`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }
    }, { signal })
  signal.throwIfAborted()
  if (!response.ok) throw new DesktopIdentityError(response.status)

  let body: unknown
  try {
    body = await response.json()
  } catch {
    signal.throwIfAborted()
    throw new Error('Everlook returned an invalid desktop identity.')
  }
  signal.throwIfAborted()
  const identity = identitySchema.safeParse(body)
  if (!identity.success) throw new Error('Everlook returned an invalid desktop identity.')
  return {
    id: identity.data.id,
    name: identity.data.name,
    tokenHash: createHash('sha256').update(token).digest('hex'),
    ...(identity.data.security ? { security: identity.data.security } : {})
  }
}
