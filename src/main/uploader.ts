import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { boundedRequest, retryAfterMilliseconds } from './request'

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds))

export async function readStableWorldFile(
  filePath: string,
  sleep: (milliseconds: number) => Promise<void> = delay
): Promise<Buffer> {
  for (let attempt = 0;attempt < 4;attempt += 1) {
    const before = await stat(filePath)
    await sleep(750)
    const stable = await stat(filePath)
    if (before.size !== stable.size || before.mtimeMs !== stable.mtimeMs) continue

    const contents = await readFile(filePath)
    const after = await stat(filePath)
    if (stable.size === after.size && stable.mtimeMs === after.mtimeMs) return contents
  }
  throw unstableWorldFileError()
}

/** Recovery retries this. The file can keep changing past the short settle window. */
export const UNSTABLE_WORLD_FILE_CODE = 'EUNSTABLE'

function unstableWorldFileError(): Error {
  return Object.assign(
    new Error('Everlook.lua is still changing. Everlook will try again after it settles.'),
    { code: UNSTABLE_WORLD_FILE_CODE }
  )
}

export type UploadStep = 'check' | 'storage' | 'queue'

export type UploadExchange = {
  step: UploadStep
  status: number
  message: string | null
  uploadId: number | null
  uploadStatus: string | null
  duplicate: boolean
}

export type UploadResult = {
  hash: string
  uploadedAt: string | null
  unchanged: boolean
  responses: UploadExchange[]
}

export class UploadError extends Error {
  readonly responses: UploadExchange[]
  readonly httpStatus: number | null
  readonly retryAfterMs: number | null
  readonly code: string | null
  readonly setupUrl: string | null

  constructor(message: string, responses: UploadExchange[], options?: { cause?: unknown; httpStatus?: number; retryAfterMs?: number | null; code?: string | null; setupUrl?: string | null }) {
    super(message, options)
    this.name = 'UploadError'
    this.responses = responses
    this.httpStatus = options?.httpStatus ?? responses.at(-1)?.status ?? null
    this.retryAfterMs = options?.retryAfterMs ?? null
    this.code = options?.code ?? null
    this.setupUrl = options?.setupUrl ?? null
  }
}

const stepLabels: Record<UploadStep, string> = {
  check: 'Check',
  storage: 'Storage',
  queue: 'Queue'
}

export function describeUpload(result: Pick<UploadResult, 'unchanged' | 'responses'>): string {
  if (result.unchanged) return 'No request sent. This file matches the last upload.'
  if (result.responses.length === 0) return 'Everlook returned no response.'
  return result.responses.map(describeExchange).join('\n\n')
}

export function uploadOutcome(result: UploadResult): 'uploaded' | 'unchanged' {
  if (result.unchanged) return 'unchanged'
  const last = result.responses.at(-1)
  if (last?.duplicate === true) return 'unchanged'
  return 'uploaded'
}

function describeExchange(exchange: UploadExchange): string {
  const lines = [`${stepLabels[exchange.step]} ${exchange.status}`]
  if (exchange.message !== null) lines.push(exchange.message)
  const facts = [
    exchange.uploadId === null ? null : `Upload ${exchange.uploadId}`,
    exchange.uploadStatus,
    exchange.duplicate ? 'duplicate' : null
  ].filter((fact): fact is string => fact !== null && fact !== '')
  if (facts.length > 0) lines.push(facts.join(' · '))
  return lines.join('\n')
}

type Dependencies = {
  previousHash: (filePath: string) => string | null
  token: () => Promise<string | null>
  baseUrl: () => string
  saved: (filePath: string, hash: string, uploadedAt: string) => Promise<void>
  readStable?: (filePath: string) => Promise<Buffer>
  request?: typeof fetch
  sleep?: (milliseconds: number) => Promise<void>
}

type SignedUpload = {
  duplicate: boolean
  key: string | null
  url: string | null
  headers: Record<string, string>
  method: string
}

export class UploadCoordinator {
  private readonly queues = new Map<string, Promise<UploadResult>>()

  constructor(private readonly dependencies: Dependencies) { }

  isBusy(): boolean {
    return this.queues.size > 0
  }

  upload(filePath: string, options: { force?: boolean; signal?: AbortSignal } = {}): Promise<UploadResult> {
    const previous =
      this.queues.get(filePath) ??
      Promise.resolve({ hash: '', uploadedAt: null, unchanged: true, responses: [] })
    const current = previous.catch(() => undefined).then(() => this.perform(filePath, options.force === true, options.signal))
    this.queues.set(filePath, current)
    const clear = (): void => {
      if (this.queues.get(filePath) === current) this.queues.delete(filePath)
    }
    void current.then(clear, clear)
    return current
  }

  private async perform(filePath: string, force: boolean, signal?: AbortSignal): Promise<UploadResult> {
    signal?.throwIfAborted()
    if (path.basename(filePath).toLowerCase() !== 'everlook.lua') {
      throw new Error('Only Everlook.lua files can be uploaded.')
    }

    const contents = await (this.dependencies.readStable ?? readStableWorldFile)(filePath)
    signal?.throwIfAborted()
    const hash = createHash('sha256').update(contents).digest('hex')
    if (!force && this.dependencies.previousHash(filePath) === hash) {
      return { hash, uploadedAt: null, unchanged: true, responses: [] }
    }

    const token = await this.dependencies.token()
    if (token === null) throw new Error('Sign in to Everlook before uploading.')

    const request = this.dependencies.request ?? fetch
    const sleep = this.dependencies.sleep ?? delay
    signal?.throwIfAborted()
    const origin = this.dependencies.baseUrl()
    const byteSize = contents.byteLength
    const responses: UploadExchange[] = []

    const intent = await this.authorizedJson(
      request,
      sleep,
      token,
      `${origin}/api/desktop/addon/uploads`,
      {
        sha256: hash,
        byte_size: byteSize,
        original_name: 'Everlook.lua'
      },
      responses,
      'check',
      signal
    )

    if (!intent.duplicate) {
      if (intent.url === null || intent.key === null) {
        throw new UploadError('Everlook did not return a signed upload URL.', responses)
      }

      await this.putObject(request, sleep, intent.url, intent.headers, contents, responses, signal)

      await this.authorizedJson(
        request,
        sleep,
        token,
        `${origin}/api/desktop/addon/uploads/complete`,
        {
          key: intent.key,
          sha256: hash,
          byte_size: byteSize
        },
        responses,
        'queue',
        signal
      )
    }

    signal?.throwIfAborted()
    const uploadedAt = new Date().toISOString()
    await this.dependencies.saved(filePath, hash, uploadedAt)
    return { hash, uploadedAt, unchanged: false, responses }
  }

  private async authorizedJson(
    request: typeof fetch,
    sleep: (milliseconds: number) => Promise<void>,
    token: string,
    url: string,
    body: Record<string, string | number>,
    responses: UploadExchange[],
    step: 'check' | 'queue',
    signal?: AbortSignal
  ): Promise<SignedUpload> {
    const response = await this.retry(
      request,
      sleep,
      url,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      },
      responses,
      signal
    )

    const text = await response.text()
    const payload = parseJson(text)
    responses.push(toExchange(step, response.status, payload, text, response.ok))
    if (!response.ok) {
      throw new UploadError(failureMessage(response.status, payload), responses, {
        httpStatus: response.status,
        retryAfterMs: retryAfterMilliseconds(response.headers.get('retry-after')),
        code: bodyString(payload.code),
        setupUrl: bodyString(payload.setup_url)
      })
    }

    const upload = payload.upload
    return {
      duplicate: upload?.duplicate === true,
      key: typeof upload?.key === 'string' ? upload.key : null,
      url: typeof upload?.url === 'string' ? upload.url : null,
      headers: stringifyHeaders(upload?.headers),
      method: typeof upload?.method === 'string' ? upload.method : 'PUT'
    }
  }

  private async putObject(
    request: typeof fetch,
    sleep: (milliseconds: number) => Promise<void>,
    url: string,
    headers: Record<string, string>,
    contents: Buffer,
    responses: UploadExchange[],
    signal?: AbortSignal
  ): Promise<void> {
    const putHeaders: Record<string, string> = { ...headers }
    delete putHeaders.Host
    delete putHeaders.host
    if (putHeaders['Content-Type'] === undefined && putHeaders['content-type'] === undefined) {
      putHeaders['Content-Type'] = 'text/x-lua'
    }

    const response = await this.retry(
      request,
      sleep,
      url,
      {
        method: 'PUT',
        headers: putHeaders,
        body: contents
      },
      responses,
      signal
    )

    if (!response.ok) {
      const text = await response.text()
      responses.push(storageExchange(response.status, snippet(text)))
      throw new UploadError(`Object storage rejected the world file (${response.status}).`, responses, { httpStatus: response.status, retryAfterMs: retryAfterMilliseconds(response.headers.get('retry-after')) })
    }

    responses.push(storageExchange(response.status, null))
  }

  private async retry(
    request: typeof fetch,
    sleep: (milliseconds: number) => Promise<void>,
    url: string,
    init: RequestInit,
    responses: UploadExchange[],
    signal?: AbortSignal
  ): Promise<Response> {
    for (let attempt = 0;attempt < 4;attempt += 1) {
      try {
        const response = await boundedRequest(request, url, init, { signal, timeoutMs: init.method === 'PUT' ? 120_000 : 30_000 })
        if (response.ok || response.headers.has('retry-after') || !isTransient(response.status) || attempt === 3) return response
      } catch (error) {
        signal?.throwIfAborted()
        if (attempt === 3) {
          throw new UploadError(`Everlook could not be reached: ${errorMessage(error)}`, responses, {
            cause: error
          })
        }
      }
      await sleep(500 * 2 ** attempt)
    }

    throw new UploadError('No response from Everlook.', responses)
  }
}

function stringifyHeaders(value: unknown): Record<string, string> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}

  const headers: Record<string, string> = {}
  for (const [name, header] of Object.entries(value)) {
    if (typeof header === 'string') headers[name] = header
  }
  return headers
}

function isTransient(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500
}

type JsonBody = {
  message?: unknown
  code?: unknown
  setup_url?: unknown
  errors?: unknown
  upload?: {
    id?: unknown
    status?: unknown
    duplicate?: unknown
    key?: unknown
    url?: unknown
    headers?: unknown
    method?: unknown
  }
}

function bodyString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

function parseJson(text: string): JsonBody {
  if (text.trim() === '') return {}
  try {
    const value = JSON.parse(text) as unknown
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value as JsonBody
    return {}
  } catch {
    return {}
  }
}

function toExchange(
  step: 'check' | 'queue',
  status: number,
  payload: JsonBody,
  text: string,
  ok: boolean
): UploadExchange {
  const upload = payload.upload
  return {
    step,
    status,
    message: responseMessage(payload, text, ok),
    uploadId: uploadId(upload?.id),
    uploadStatus: typeof upload?.status === 'string' ? upload.status : null,
    duplicate: upload?.duplicate === true
  }
}

function storageExchange(status: number, message: string | null): UploadExchange {
  return {
    step: 'storage',
    status,
    message,
    uploadId: null,
    uploadStatus: null,
    duplicate: false
  }
}

function responseMessage(payload: JsonBody, text: string, ok: boolean): string | null {
  const fields = fieldErrors(payload)
  if (fields !== null) return fields
  if (typeof payload.message === 'string' && payload.message.trim() !== '') return payload.message.trim()
  if (!ok) return snippet(text)
  return null
}

function fieldErrors(payload: JsonBody): string | null {
  if (payload.errors === null || typeof payload.errors !== 'object' || Array.isArray(payload.errors)) {
    return null
  }

  const lines: string[] = []
  for (const [field, messages] of Object.entries(payload.errors)) {
    if (!Array.isArray(messages)) continue
    for (const message of messages) {
      if (typeof message === 'string' && message.trim() !== '') lines.push(`${field}: ${message.trim()}`)
    }
  }
  return lines.length === 0 ? null : lines.join('\n')
}

function uploadId(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value)
  return null
}

function snippet(text: string): string | null {
  const compact = text.replace(/\s+/g, ' ').trim()
  if (compact === '') return null
  return compact.replace(/https?:\/\/\S+/g, '[url]').slice(0, 180)
}

function failureMessage(status: number, payload: JsonBody): string {
  const detail = fieldErrors(payload) ?? (typeof payload.message === 'string' ? payload.message : 'Unexpected response.')
  if (status === 401) return 'Your Everlook session expired. Sign in again.'
  if (status === 422) return `Everlook rejected this world file: ${detail}`
  return `Upload failed (${status}): ${detail}`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown network error.'
}
