import type { SigningState } from '../shared/types'
import { fingerprintOf } from './signing-token'

export type SigningInstall = {
  addonsDirectory: string
  /** Fingerprint of the token in sign.lua, or null when there is none. */
  placed: string | null
  /** Token placement is blocked because the target file is not safe to write. */
  skipped: boolean
}

export function idleSigningState(): SigningState {
  return { status: 'unknown', fingerprint: null, placedPath: null, error: null }
}

/**
 * Where the signing token stands, from the first install the app manages.
 * `verified` needs the addon's own proof: a signer in SavedVariables that
 * matches the token in sign.lua.
 */
export function resolveSigningState(input: {
  installs: SigningInstall[]
  accountSigner: string | null
  savedSigners: (string | null)[]
}): SigningState {
  const managed = input.installs.filter((install) => !install.skipped)
  if (input.installs.length > 0 && managed.length === 0) {
    return { ...idleSigningState(), status: 'skipped' }
  }
  const placed = managed.find((install) => install.placed !== null)
  if (placed === undefined || placed.placed === null) {
    return { ...idleSigningState(), status: 'not_placed' }
  }
  const base = {
    fingerprint: placed.placed,
    placedPath: placed.addonsDirectory,
    error: null
  }
  if (input.accountSigner !== null && fingerprintOf(input.accountSigner) !== placed.placed) {
    return { ...base, status: 'stale' }
  }
  const proven = input.savedSigners.some(
    (signer) => signer !== null && fingerprintOf(signer) === placed.placed
  )
  return { ...base, status: proven ? 'verified' : 'placed' }
}
