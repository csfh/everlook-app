import { describe, expect, it } from 'vitest'
import { nextIngestPolls, type IngestHistoryMark } from './ingest-polls'

const scope = 'https://everlook.ing|7'

function mark(overrides: Partial<IngestHistoryMark> = {}): IngestHistoryMark {
  return {
    path: '/wow/Everlook.lua',
    hash: 'a'.repeat(64),
    outcome: 'uploaded',
    ingestStatus: null,
    signed: null,
    ...overrides
  }
}

describe('nextIngestPolls', () => {
  it('follows an upload until ingest finishes and the signature is known', () => {
    const open = [
      mark({ path: '/missing-hash.lua', hash: null }),
      mark({ path: '/failed-transfer.lua', outcome: 'error' }),
      mark({ path: '/failed-ingest.lua', ingestStatus: 'failed', signed: null }),
      mark({ path: '/rejected.lua', ingestStatus: 'rejected' }),
      mark({ path: '/cancelled.lua', ingestStatus: 'cancelled' }),
      mark({ path: '/done.lua', ingestStatus: 'completed', signed: 'signed' }),
      mark({ path: '/unsigned.lua', hash: 'b'.repeat(64), ingestStatus: 'completed', signed: 'unsigned' }),
      mark({ path: '/awaiting-signature.lua', hash: 'c'.repeat(64), ingestStatus: 'completed', signed: null }),
      mark({ path: '/processing.lua', hash: 'd'.repeat(64), ingestStatus: 'processing' })
    ]

    expect(nextIngestPolls({ history: open, scope, inFlight: new Set() })).toEqual([
      { path: '/awaiting-signature.lua', hash: 'c'.repeat(64), key: `${scope}|${'c'.repeat(64)}` },
      { path: '/processing.lua', hash: 'd'.repeat(64), key: `${scope}|${'d'.repeat(64)}` }
    ])
  })

  it('skips a poll already running and stops after two at once', () => {
    const history = [
      mark({ path: '/one.lua', hash: '1'.repeat(64) }),
      mark({ path: '/one-again.lua', hash: '1'.repeat(64) }),
      mark({ path: '/two.lua', hash: '2'.repeat(64) }),
      mark({ path: '/three.lua', hash: '3'.repeat(64) })
    ]
    const running = new Set([`${scope}|${'1'.repeat(64)}`])

    expect(nextIngestPolls({ history, scope, inFlight: running }).map((poll) => poll.path)).toEqual(['/two.lua'])
    expect(nextIngestPolls({
      history,
      scope,
      inFlight: new Set([`${scope}|${'1'.repeat(64)}`, `${scope}|${'2'.repeat(64)}`])
    })).toEqual([])
  })
})
