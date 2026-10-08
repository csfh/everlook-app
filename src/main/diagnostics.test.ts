import { describe, expect, it } from 'vitest'
import { buildDiagnostics } from './diagnostics'
import { getPlatformCapabilities } from './platform'

const platform = getPlatformCapabilities({ platform: 'linux', arch: 'x64', packaged: true, appImage: '' })
const basic = {
  app: { version: '0.5.0', packaged: true, electronVersion: '44.4.1' },
  platform,
  credentialStorage: 'os-keyring' as const,
  homeDirectory: '/home/alice'
}

describe('sanitized diagnostics', () => {
  it('includes app/platform/credential mode and useful installation and file metadata', () => {
    const report = buildDiagnostics({
      ...basic,
      installs: [{ path: '/home/alice/Games/Interface/AddOns/Everlook', version: '0.4.0', status: 'current' }],
      files: [{ path: '/home/alice/Games/WTF/Account/12345/SavedVariables/Everlook.lua', status: 'uploaded', lastUploadedAt: '2026-10-03T00:00:00.000Z', signed: 'signed' }],
      uploads: { pending: 2, history: 10 }
    })
    expect(report.app).toEqual({ name: 'Everlook', version: '0.5.0', packaged: true, electronVersion: '44.4.1' })
    expect(report.platform).toEqual(platform)
    expect(report.credentialStorage).toBe('os-keyring')
    expect(report.installs[0]).toMatchObject({ path: '~/Games/Interface/AddOns/Everlook', version: '0.4.0', status: 'current' })
    expect(report.files[0]).toMatchObject({ path: '~/Games/WTF/Account/[account]/SavedVariables/Everlook.lua', status: 'uploaded', lastUploadedAt: '2026-10-03T00:00:00.000Z', signed: 'signed' })
    expect(report.uploads).toEqual({ pending: 2, history: 10 })
    expect(JSON.stringify(report)).not.toContain('alice')
    expect(JSON.stringify(report)).not.toContain('12345')
  })

  it('ignores additional state, tokens, signing values, hashes, exports and HTTP responses at every level', () => {
    const token = 'abcdef01'.repeat(8)
    const file = {
      path: '/home/alice/WTF/Account/private/SavedVariables/Everlook.lua', status: 'error' as const,
      account: 'private', hash: token, response: '{secret-response}', rawExport: 'Everlook = {secret-export}',
      error: Object.assign(new Error(`Bearer ${token} secret-response secret-export`), { code: 'ECONNRESET', response: 'secret-response' })
    }
    const input = {
      ...basic, files: [file], token, accountSigner: token, signing: { token, fingerprint: 'abcdef01' },
      settings: { token }, platform: { ...platform, token }, app: { ...basic.app, token },
      uploads: { pending: 3, history: 9, rows: [file] }
    }
    const report = buildDiagnostics(input)
    const serialized = JSON.stringify(report)
    for (const forbidden of [token, 'accountSigner', 'fingerprint', 'rawExport', 'secret-export', 'secret-response', 'Bearer', 'rows', 'private', 'response', 'hash']) {
      expect(serialized).not.toContain(forbidden)
    }
    expect(report.files[0]?.error).toEqual({ present: true, code: 'ECONNRESET', httpStatus: null })
  })

  it('strips URL credentials, queries and fragments instead of leaking a presigned URL', () => {
    const report = buildDiagnostics({
      ...basic,
      baseUrl: 'https://username:password@example.com/world?X-Amz-Signature=SECRET#TOKEN',
      installs: [{ path: 'https://username:password@cdn.example.com/addon?X-Amz-Signature=SECRET#TOKEN' }],
      errors: [{ source: 'upload', error: { message: 'https://bucket/world?X-Amz-Signature=SECRET', statusCode: 403 } }]
    })
    expect(report.baseUrl).toBe('https://example.com')
    expect(report.installs[0]?.path).toBe('https://cdn.example.com')
    const serialized = JSON.stringify(report)
    for (const forbidden of ['username', 'password', 'X-Amz', 'SECRET', 'TOKEN', 'bucket']) expect(serialized).not.toContain(forbidden)
    expect(report.errors[0]).toEqual({ source: 'upload', error: { present: true, code: null, httpStatus: 403 } })
  })

  it.each([
    ['darwin', '/Users/Alice', '/Users/Alice/Games/WTF/Account/my-account/SavedVariables/Everlook.lua'],
    ['win32', 'C:\\Users\\Alice', 'c:\\users\\alice\\Games\\WTF\\Account\\my-account\\SavedVariables\\Everlook.lua']
  ] as const)('redacts native home paths and account names on %s', (platformName, homeDirectory, filePath) => {
    const report = buildDiagnostics({ ...basic, homeDirectory, platform: getPlatformCapabilities({ platform: platformName }), files: [{ path: filePath, status: 'watching' }] })
    expect(report.files[0]?.path).toBe('~/Games/WTF/Account/[account]/SavedVariables/Everlook.lua')
    expect(JSON.stringify(report).toLowerCase()).not.toContain('alice')
    expect(JSON.stringify(report)).not.toContain('my-account')
  })

  it('keeps unknown errors useful without forwarding free-form strings or attacker-supplied error codes', () => {
    const report = buildDiagnostics({ ...basic, errors: [
      { source: 'credentials', error: 'API_TOKEN=secret' },
      { source: 'update', error: { code: 'SECRET-CODE', statusCode: 999, stack: 'private' } },
      { source: 'launcher', error: null }
    ] })
    expect(report.errors.map((entry) => entry.error)).toEqual([
      { present: true, code: null, httpStatus: null },
      { present: true, code: null, httpStatus: null },
      { present: false, code: null, httpStatus: null }
    ])
    expect(JSON.stringify(report)).not.toMatch(/secret|private|stack/i)
  })

  it('validates supposedly structured strings and numeric counts rather than copying arbitrary content', () => {
    const report = buildDiagnostics({
      ...basic, app: { version: 'token=SECRET', packaged: false, electronVersion: 'token=SECRET' },
      installs: [{ path: '/home/alice/App', version: 'token=SECRET', status: 'token=SECRET' }],
      files: [{ path: '/Users/bob/WTF/Account/abc/SavedVariables/Everlook.lua', status: 'idle', lastUploadedAt: 'token=SECRET' }],
      uploads: { pending: -1, history: Infinity }, baseUrl: 'javascript:SECRET'
    })
    expect(report.app.version).toBeNull()
    expect(report.app.electronVersion).toBeNull()
    expect(report.installs[0]?.status).toBeNull()
    expect(report.files[0]?.lastUploadedAt).toBeNull()
    expect(report.files[0]?.path).toBe('~/WTF/Account/[account]/SavedVariables/Everlook.lua')
    expect(report.uploads).toEqual({ pending: 0, history: 0 })
    expect(report.baseUrl).toBeNull()
    expect(JSON.stringify(report)).not.toMatch(/SECRET|bob/)
  })

  it('records update, launcher, and upload status without account names or error text', () => {
    const report = buildDiagnostics({
      ...basic,
      installs: [{ path: '/home/alice/AddOns', status: 'behind', signing: 'stale' }],
      session: {
        authenticated: true,
        autoWatch: false,
        accountError: 'Sign in again as Alice, token=SECRET',
        startup: { supported: true, enabled: false, error: 'EACCES on /home/alice' },
        update: { status: 'error', mode: 'automatic', error: { code: 'ENOTFOUND', message: 'secret feed' } },
        launcher: { status: 'running', error: null },
        pending: [{ status: 'retrying' }, { status: 'blocked' }, { status: 'nope' }, { status: 'constructor' }]
      }
    })
    expect(report.session).toMatchObject({
      authenticated: true,
      autoWatch: false,
      accountError: { present: true, code: null, httpStatus: null },
      startup: { supported: true, enabled: false, error: { present: true, code: null, httpStatus: null } },
      update: { status: 'error', mode: 'automatic', error: { present: true, code: 'ENOTFOUND', httpStatus: null } },
      launcher: { status: 'running', error: { present: false, code: null, httpStatus: null } },
      pending: { retrying: 1, blocked: 1, queued: 0, uploading: 0 }
    })
    expect(report.installs[0]?.signing).toBe('stale')
    expect(buildDiagnostics({ ...basic, installs: [{ path: '/home/alice/AddOns', signing: 'SECRET' }] }).installs[0]?.signing).toBeNull()
    const serialized = JSON.stringify(report)
    for (const forbidden of ['Alice', 'SECRET', 'secret', 'nope', 'constructor', 'alice', 'EACCES on']) {
      expect(serialized).not.toContain(forbidden)
    }
  })

  it('returns independent snapshots without changing the input', () => {
    const input = { ...basic, files: [{ path: '/home/alice/file', status: 'idle' as const }] }
    const before = JSON.stringify(input)
    const report = buildDiagnostics(input)
    report.platform.arch = 'mutated'
    expect(JSON.stringify(input)).toBe(before)
  })
})
