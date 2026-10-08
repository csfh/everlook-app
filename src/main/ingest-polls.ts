const POLL_LIMIT = 2
const SETTLED_INGEST = new Set(['failed', 'rejected', 'cancelled'])

export type IngestHistoryMark = {
  path: string
  hash: string | null
  outcome: 'uploaded' | 'unchanged' | 'error'
  ingestStatus: string | null
  signed: 'signed' | 'unsigned' | null
}

export type IngestPoll = { path: string; hash: string; key: string }

/**
 * Uploads that still need an ingest check.
 * A completed ingest with no signature stays open. Two checks run at once.
 * The first mark for a hash wins, and history is already newest first.
 */
export function nextIngestPolls(input: {
  history: readonly IngestHistoryMark[]
  scope: string
  inFlight: ReadonlySet<string>
}): IngestPoll[] {
  const polls: IngestPoll[] = []
  const claimed = new Set(input.inFlight)
  if (claimed.size >= POLL_LIMIT) return polls
  for (const entry of input.history) {
    if (!entry.hash || entry.outcome === 'error') continue
    if (entry.ingestStatus !== null && SETTLED_INGEST.has(entry.ingestStatus)) continue
    if (entry.ingestStatus === 'completed' && entry.signed !== null) continue
    const key = `${input.scope}|${entry.hash}`
    if (claimed.has(key)) continue
    claimed.add(key)
    polls.push({ path: entry.path, hash: entry.hash, key })
    if (claimed.size >= POLL_LIMIT) break
  }
  return polls
}
