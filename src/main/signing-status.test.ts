import { describe, expect, it } from 'vitest'
import { resolveSigningState } from './signing-status'

const placed = { addonsDirectory: '/wow/AddOns', placed: 'ba7816bf', skipped: false }

describe('resolveSigningState', () => {
  it('is not placed with no install or no token', () => {
    expect(resolveSigningState({ installs: [], accountSigner: null, savedSigners: [] }).status).toBe('not_placed')
    expect(
      resolveSigningState({
        installs: [{ ...placed, placed: null }],
        accountSigner: null,
        savedSigners: []
      }).status
    ).toBe('not_placed')
  })

  it('skips dev checkouts and symlinks', () => {
    expect(
      resolveSigningState({
        installs: [{ ...placed, skipped: true }],
        accountSigner: null,
        savedSigners: []
      }).status
    ).toBe('skipped')
  })

  it('is placed until the addon signs with the token', () => {
    const state = resolveSigningState({
      installs: [placed],
      accountSigner: 'ba7816bf8f01cfea',
      savedSigners: [null, 'ffffffffffffffff']
    })
    expect(state).toMatchObject({ status: 'placed', fingerprint: 'ba7816bf' })
  })

  it('is verified when SavedVariables carries the same signer', () => {
    const state = resolveSigningState({
      installs: [placed],
      accountSigner: 'ba7816bf8f01cfea',
      savedSigners: ['ba7816bf8f01cfea']
    })
    expect(state.status).toBe('verified')
  })

  it('is stale when the placed token is not the account token', () => {
    const state = resolveSigningState({
      installs: [placed],
      accountSigner: '1111111122222222',
      savedSigners: ['ba7816bf8f01cfea']
    })
    expect(state.status).toBe('stale')
  })
})
