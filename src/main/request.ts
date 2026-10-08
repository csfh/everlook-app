export async function boundedRequest(
  request: typeof fetch,
  url: Parameters<typeof fetch>[0],
  init: RequestInit = {},
  options: { timeoutMs?: number; signal?: AbortSignal | undefined } = {}
): Promise<Response> {
  options.signal?.throwIfAborted()
  const deadline = AbortSignal.timeout(options.timeoutMs ?? 30_000)
  const signals = [deadline, options.signal, init.signal].filter((signal): signal is AbortSignal => signal != null)
  return request(url, { ...init, signal: AbortSignal.any(signals) })
}

export function retryAfterMilliseconds(value: string | null, now = Date.now()): number | null {
  if (value === null) return null
  if (/^\d+(?:\.\d+)?$/.test(value.trim())) return Number.isFinite(Number(value) * 1000) ? Number(value) * 1000 : null
  // HTTP dates contain a weekday; numeric strings and negative numbers are not dates.
  if (!/^[A-Za-z]{3},/.test(value.trim())) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? Math.max(0, parsed - now) : null
}
