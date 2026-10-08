import { z } from 'zod'
import { boundedRequest } from './request'

export type SignedVerdict = 'signed' | 'unsigned'

export type UploadIngestVerdict = {
  id: number
  status: string
  signed: SignedVerdict | null
  error: string | null
}

export type IngestPollingOptions = {
  baseUrl: string
  token: string
  sha256: string
  request?: typeof fetch | undefined
  sleep?: ((milliseconds: number) => Promise<void>) | undefined
  attempts?: number | undefined
  intervalMs?: number | undefined
  signal?: AbortSignal | undefined
  onStatus?: ((verdict: UploadIngestVerdict) => void | Promise<void>) | undefined
}

const PENDING = new Set(['pending', 'parsing'])
const FINAL = new Set(['processing', 'completed'])
const TERMINAL = new Set(['completed', 'failed', 'rejected', 'cancelled'])
const KNOWN = new Set([...PENDING, 'processing', ...TERMINAL])

const ingestSchema = z.object({
  upload: z.object({
    id: z.number().int().positive(),
    status: z.string(),
    signed: z.boolean(),
    error: z.string().nullable().optional()
  })
})

/** Transfer acceptance and a signature verdict can precede completed ingest by several jobs. */
export async function waitForIngest(options: IngestPollingOptions): Promise<UploadIngestVerdict | null> {
  const request = options.request ?? fetch
  const attempts = options.attempts ?? 30
  const intervalMs = options.intervalMs ?? 3000
  const url = `${options.baseUrl.replace(/\/$/, '')}/api/desktop/addon/uploads/${encodeURIComponent(options.sha256)}`
  let previous: UploadIngestVerdict | null = null

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (options.signal?.aborted) return null
    if (attempt > 0) {
      await (options.sleep?.(intervalMs) ?? delayWithAbort(intervalMs, options.signal))
      if (options.signal?.aborted) return null
    }
    let verdict: UploadIngestVerdict
    try {
      const response = await boundedRequest(request, url, {
        headers: { Authorization: `Bearer ${options.token}`, Accept: 'application/json' }
      }, { signal: options.signal })
      if (options.signal?.aborted) return null
      if (!response.ok) {
        const transient = [404, 408, 425, 429].includes(response.status) || response.status >= 500
        if (!transient) return null
        continue
      }
      const parsed = ingestSchema.safeParse(await response.json())
      if (options.signal?.aborted) return null
      if (!parsed.success || !KNOWN.has(parsed.data.upload.status)) continue
      const upload = parsed.data.upload
      verdict = {
        id: upload.id,
        status: upload.status,
        signed: FINAL.has(upload.status) ? (upload.signed ? 'signed' : 'unsigned') : null,
        error: upload.error ?? null
      }
    } catch {
      if (options.signal?.aborted) return null
      // Transport errors and incomplete JSON are not an ingest verdict.
      continue
    }
    if (previous === null || previous.id !== verdict.id || previous.status !== verdict.status ||
      previous.signed !== verdict.signed || previous.error !== verdict.error) {
      // Keep callback failures visible: a failed history write is not a network retry.
      await options.onStatus?.(verdict)
      previous = verdict
    }
    if (options.signal?.aborted) return null
    if (TERMINAL.has(verdict.status)) return verdict
  }
  return null
}

function delayWithAbort(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) { resolve(); return }
    const done = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, milliseconds)
    signal?.addEventListener('abort', done, { once: true })
  })
}
