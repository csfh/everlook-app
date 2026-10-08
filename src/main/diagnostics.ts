import type { CredentialStorage, UploadStatus } from '../shared/types'
import type { PlatformCapabilities } from './platform'

export type DiagnosticErrorSource = 'upload' | 'addon' | 'launcher' | 'startup' | 'update' | 'credentials'
export type DiagnosticsInput = {
  app: { version: string; packaged: boolean; electronVersion?: string }
  platform: PlatformCapabilities
  credentialStorage: CredentialStorage
  homeDirectory: string
  baseUrl?: string
  installs?: readonly { path: string; version?: string | null; status?: string; signing?: string; error?: unknown }[]
  files?: readonly {
    path: string
    status: UploadStatus
    lastDetectedAt?: string | null
    lastUploadedAt?: string | null
    signed?: 'signed' | 'unsigned' | null
    error?: unknown
  }[]
  uploads?: { pending: number; history: number }
  errors?: readonly { source: DiagnosticErrorSource; error: unknown }[]
  session?: {
    authenticated?: boolean
    autoWatch?: boolean
    accountError?: unknown
    startup?: { supported?: boolean; enabled?: boolean; error?: unknown }
    update?: { status?: string; mode?: string; error?: unknown }
    launcher?: { status?: string; error?: unknown }
    pending?: readonly { status?: string }[]
  }
}

const ERROR_CODES = new Set([
  'ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'EROFS', 'EIO', 'ENOSPC',
  'ENOTFOUND', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE',
  'ERR_NETWORK', 'ERR_INTERNET_DISCONNECTED', 'ERR_CONNECTION_REFUSED',
  'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND', 'ERR_UPDATER_INVALID_SIGNATURE',
  'ERR_UPDATER_NO_CHECKSUM', 'ERR_UPDATER_CHECKSUM_MISMATCH'
])
const INSTALL_STATUSES = new Set(['idle', 'checking', 'installing', 'current', 'behind', 'missing', 'git', 'error'])
const FILE_STATUSES = new Set(['idle', 'watching', 'uploading', 'uploaded', 'unchanged', 'error'])
const SIGNING_STATUSES = new Set(['unknown', 'not_placed', 'placed', 'verified', 'stale', 'skipped'])
const UPDATE_STATUSES = new Set(['idle', 'unavailable', 'checking', 'available', 'downloading', 'ready', 'current', 'error'])
const UPDATE_MODES = new Set(['automatic', 'manual', 'unsupported'])
const LAUNCHER_STATUSES = new Set(['idle', 'starting', 'running', 'stopping', 'error'])
const PENDING_STATUSES = ['queued', 'uploading', 'retrying', 'auth-required', 'security-required', 'contributions-revoked', 'blocked'] as const
const PENDING_STATUS_SET = new Set<string>(PENDING_STATUSES)

export function buildDiagnostics(input: DiagnosticsInput) {
  return {
    app: {
      name: 'Everlook',
      version: version(input.app.version),
      packaged: input.app.packaged,
      electronVersion: version(input.app.electronVersion)
    },
    platform: {
      platform: input.platform.platform,
      arch: input.platform.arch,
      managedWowLauncher: input.platform.managedWowLauncher,
      nativeBattleNet: input.platform.nativeBattleNet,
      loginStartup: input.platform.loginStartup,
      automaticUpdates: input.platform.automaticUpdates
    },
    credentialStorage: input.credentialStorage,
    baseUrl: origin(input.baseUrl),
    installs: (input.installs ?? []).map((install) => ({
      path: diagnosticPath(install.path, input.homeDirectory),
      version: version(install.version),
      status: install.status !== undefined && INSTALL_STATUSES.has(install.status) ? install.status : null,
      signing: install.signing !== undefined && SIGNING_STATUSES.has(install.signing) ? install.signing : null,
      error: diagnosticError(install.error)
    })),
    files: (input.files ?? []).map((file) => ({
      path: diagnosticPath(file.path, input.homeDirectory),
      status: FILE_STATUSES.has(file.status) ? file.status : null,
      lastDetectedAt: timestamp(file.lastDetectedAt),
      lastUploadedAt: timestamp(file.lastUploadedAt),
      signed: file.signed === 'signed' || file.signed === 'unsigned' ? file.signed : null,
      error: diagnosticError(file.error)
    })),
    uploads: { pending: count(input.uploads?.pending), history: count(input.uploads?.history) },
    errors: (input.errors ?? []).map((entry) => ({ source: entry.source, error: diagnosticError(entry.error) })),
    session: {
      authenticated: input.session?.authenticated === true,
      autoWatch: input.session?.autoWatch === true,
      accountError: diagnosticError(input.session?.accountError),
      startup: {
        supported: input.session?.startup?.supported === true,
        enabled: input.session?.startup?.enabled === true,
        error: diagnosticError(input.session?.startup?.error)
      },
      update: {
        status: enumValue(input.session?.update?.status, UPDATE_STATUSES),
        mode: enumValue(input.session?.update?.mode, UPDATE_MODES),
        error: diagnosticError(input.session?.update?.error)
      },
      launcher: {
        status: enumValue(input.session?.launcher?.status, LAUNCHER_STATUSES),
        error: diagnosticError(input.session?.launcher?.error)
      },
      pending: pendingCounts(input.session?.pending)
    }
  }
}

export type Diagnostics = ReturnType<typeof buildDiagnostics>

function enumValue(value: string | undefined, allowed: Set<string>): string | null {
  return value !== undefined && allowed.has(value) ? value : null
}

function pendingCounts(entries: readonly { status?: string }[] | undefined): Record<(typeof PENDING_STATUSES)[number], number> {
  const counts = Object.fromEntries(PENDING_STATUSES.map((status) => [status, 0])) as Record<(typeof PENDING_STATUSES)[number], number>
  for (const entry of entries ?? []) {
    if (entry.status !== undefined && PENDING_STATUS_SET.has(entry.status)) {
      counts[entry.status as (typeof PENDING_STATUSES)[number]] += 1
    }
  }
  return counts
}

function diagnosticError(error: unknown): { present: boolean; code: string | null; httpStatus: number | null } {
  const result = { present: error != null && error !== '', code: null as string | null, httpStatus: null as number | null }
  if (typeof error !== 'object' || error === null) return result
  if ('code' in error && typeof error.code === 'string' && ERROR_CODES.has(error.code)) result.code = error.code
  const status = 'statusCode' in error ? error.statusCode : 'status' in error ? error.status : null
  if (typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599) result.httpStatus = status
  return result
}

function version(value: string | null | undefined): string | null {
  return value !== undefined && value !== null && /^\d{1,8}(?:\.\d{1,8}){1,3}(?:-(?:alpha|beta|rc)\.\d{1,8})?$/.test(value) ? value : null
}

function timestamp(value: string | null | undefined): string | null {
  return value !== undefined && value !== null && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) && Number.isFinite(Date.parse(value)) ? value : null
}

function count(value: number | undefined): number {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : 0
}

function origin(value: string | undefined): string | null {
  if (value === undefined) return null
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : null
  } catch {
    return null
  }
}

function diagnosticPath(value: string, homeDirectory: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return origin(value) ?? '[path omitted]'
  let sanitized = value.replaceAll('\\', '/')
  const home = homeDirectory.replaceAll('\\', '/').replace(/\/+$/, '')
  const ignoreCase = /^[a-z]:\//i.test(home)
  const comparison = ignoreCase ? sanitized.toLowerCase() : sanitized
  const homeComparison = ignoreCase ? home.toLowerCase() : home
  if (home !== '' && (comparison === homeComparison || comparison.startsWith(`${homeComparison}/`))) {
    sanitized = `~${sanitized.slice(home.length)}`
  }
  const withoutQueries = sanitized
    .replace(/(?:[a-z]:)?\/(?:home|Users)\/[^/]+/gi, '~')
    .replace(/(\/WTF\/Account\/)[^/]+/gi, '$1[account]')
    .split(/[?#]/, 1)[0]?.replace(/[a-f0-9]{64}/gi, '[redacted]') ?? '[path omitted]'
  return Array.from(withoutQueries).filter((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127).join('')
}
