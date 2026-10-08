import { describe, expect, it } from 'vitest'
import type { AppState, UploadHistoryEntry } from '../../shared/types'
import { fileAttention, firstExportStatus, historyOutcome, installationFlavor, installationsOf, pendingLabel } from './desktop-state'

describe('desktop view state', () => {
  const exportEntry: UploadHistoryEntry = { id: 'export', path: '/wow/Everlook.lua', scope: 'site/account', at: '2026-10-04T00:00:00Z', outcome: 'uploaded', hash: null, uploadId: 67, ingestStatus: 'completed', signed: 'signed', error: null }

  it('reports failed server processing before an unknown signature', () => {
    const error = 'This world file could not be processed. Try uploading it again.'
    expect(firstExportStatus(exportEntry.path, [{ ...exportEntry, ingestStatus: 'failed', signed: null, error }])).toEqual({
      label: 'Server processing needs attention', complete: false, unsigned: false, error
    })
  })

  it('keeps an unknown signature distinct from an unsigned export', () => {
    for (const ingestStatus of ['pending', 'parsing', 'processing', 'completed'] as const) {
      expect(firstExportStatus(exportEntry.path, [{ ...exportEntry, ingestStatus, signed: null }])).toEqual({
        label: 'Waiting for signature verification', complete: false, unsigned: false
      })
    }
    expect(firstExportStatus(exportEntry.path, [{ ...exportEntry, signed: 'unsigned' }])).toEqual({
      label: 'Waiting for a signed export', complete: false, unsigned: true
    })
  })

  it('shows a rejected export and transfer errors without asking to replace the token', () => {
    expect(firstExportStatus(exportEntry.path, [{ ...exportEntry, ingestStatus: 'rejected', signed: null }])).toEqual({
      label: 'Server rejected this export', complete: false, unsigned: false, error: null
    })
    expect(firstExportStatus(exportEntry.path, [{ ...exportEntry, outcome: 'error', error: 'Network unavailable' }])).toEqual({
      label: 'Upload needs attention', complete: false, unsigned: false, error: 'Network unavailable'
    })
  })

  it('keeps transport success separate from server ingest failure', () => {
    const entry: UploadHistoryEntry = { id: '1', path: '/file', scope: 'site/account', at: '2026-10-03T00:00:00Z', outcome: 'uploaded', hash: null, uploadId: 42, ingestStatus: 'failed', signed: null, error: null }
    expect(historyOutcome(entry)).toEqual({ label: 'Uploaded to Everlook', ingest: 'Ingest failed', failed: true })
    expect(historyOutcome({ ...entry, ingestStatus: 'pending' })).toEqual({ label: 'Uploaded to Everlook', ingest: 'Ingest pending', failed: false })
    expect(historyOutcome({ ...entry, outcome: 'error', ingestStatus: null })).toEqual({ label: 'Upload failed', ingest: null, failed: true })
    expect(historyOutcome({ ...entry, outcome: 'unchanged', ingestStatus: null })).toEqual({ label: 'Already uploaded', ingest: null, failed: false })
  })

  it('shows the pending reason on a failed export', () => {
    const file = { path: '/wow/Everlook.lua', status: 'error', error: 'Upload could not finish. See pending uploads for retry details.' }
    expect(fileAttention(file, [{ path: file.path, error: 'Everlook could not be reached. Waiting to retry.' }])).toBe(
      'Everlook could not be reached. Waiting to retry.'
    )
    expect(fileAttention(file, [])).toBe(file.error)
    expect(fileAttention({ ...file, status: 'watching', error: null }, [{ path: file.path, error: 'stale' }])).toBeNull()
  })

  it('describes waiting for login and scheduled retries independently', () => {
    expect(pendingLabel('auth-required')).toBe('Sign in to resume')
    expect(pendingLabel('security-required')).toBe('Secure account to resume')
    expect(pendingLabel('contributions-revoked')).toBe('Contributions revoked')
    expect(pendingLabel('retrying')).toBe('Waiting to retry')
    expect(pendingLabel('blocked')).toBe('Needs attention')
    expect(pendingLabel('uploading')).toBe('Uploading')
  })

  it('uses authoritative per-install state even when empty, and keeps legacy state usable', () => {
    const addon: AppState['addon'] = { status: 'missing', addonsPath: '/wow/Interface/AddOns', version: null, publishedVersion: null, title: null, interface: null, error: null }
    const signing: AppState['signing'] = { status: 'not_placed', fingerprint: null, placedPath: null, error: null }
    const legacy = { addon, signing, files: [] }
    expect(installationsOf(legacy)).toEqual([{ ...addon, signing, files: [] }])
    expect(installationsOf({ ...legacy, installations: [] })).toEqual([])
    expect(installationsOf({ ...legacy, addon: { ...addon, addonsPath: null } })).toEqual([])
  })

  it('names an installation by its game folder', () => {
    expect(installationFlavor('/games/World of Warcraft/_forever_/Interface/AddOns')).toBe('forever')
    expect(installationFlavor('C:\\Games\\World of Warcraft\\_classic_beta_\\Interface\\AddOns')).toBe('classic beta')
    expect(installationFlavor('/wow/Interface/AddOns')).toBe('wow')
    expect(installationFlavor('/AddOns')).toBeNull()
    expect(installationFlavor(null)).toBeNull()
  })
})
