import { describe, expect, it } from 'vitest'
import type { AddonInstallState, FileState, SigningState, WowLauncherState } from '../../shared/types'
import {
  credentialNotice,
  fileStatusLabel,
  fileStatusTone,
  formatDate,
  relativeTime,
  addonActionLabel,
  addonCopy,
  shortHash,
  updateChipLabel,
  updateCopy,
  updateErrorDetail,
  uploadsSummary,
  addonActionName,
  signingActionName,
  uploadActionName,
  wowLauncherActionLabel,
  wowLauncherCopy,
  signingActionLabel,
  signingCopy
} from './status'

function addonState(overrides: Partial<AddonInstallState>): AddonInstallState {
  return {
    status: 'idle',
    addonsPath: null,
    version: null,
    publishedVersion: null,
    title: null,
    interface: null,
    error: null,
    ...overrides
  }
}

describe('updateCopy', () => {
  it('names a ready update so the in-app prompt can show it', () => {
    expect(
      updateCopy({
        status: 'ready',
        currentVersion: '0.1.3',
        availableVersion: '0.1.4',
        downloadPercent: 100,
        error: null
      })
    ).toBe('Version 0.1.4 is ready. Install and restart after any upload finishes.')
  })

  it('includes download percent', () => {
    expect(
      updateCopy({
        status: 'downloading',
        currentVersion: '0.1.3',
        availableVersion: '0.1.4',
        downloadPercent: 42,
        error: null
      })
    ).toBe('Downloading version 0.1.4 (42%).')
  })

  it('says unpackaged builds cannot check the feed', () => {
    expect(
      updateCopy({
        status: 'unavailable',
        currentVersion: '0.1.4',
        availableVersion: null,
        downloadPercent: null,
        error: null
      })
    ).toContain('packaged AppImage')
  })

  it('says the install is current after a successful check', () => {
    expect(
      updateCopy({
        status: 'current',
        currentVersion: '0.1.4',
        availableVersion: null,
        downloadPercent: null,
        error: null
      })
    ).toBe('0.1.4 is up to date.')
  })

  it('keeps check failures distinct from an idle install', () => {
    const update = {
      status: 'error' as const,
      currentVersion: '0.1.4',
      availableVersion: null,
      downloadPercent: null,
      error: 'The update feed was not found (404): Cannot find channel "latest-linux.yml".'
    }
    expect(updateCopy(update)).toBe('Could not check for updates.')
    expect(updateErrorDetail(update)).toBe(update.error)
  })

  it('says a known version failed to download, and a bad signature failed verification', () => {
    expect(
      updateCopy({
        status: 'error',
        currentVersion: '0.1.4',
        availableVersion: '0.1.5',
        downloadPercent: null,
        error: 'Could not reach the update feed: net::ERR_INTERNET_DISCONNECTED'
      })
    ).toBe('Version 0.1.5 could not be downloaded.')
    const unverified = {
      status: 'error' as const,
      currentVersion: '0.1.4',
      availableVersion: '0.1.5',
      downloadPercent: null,
      error: 'The update could not be verified: checksum mismatch'
    }
    expect(updateCopy(unverified)).toBe('The update could not be verified.')
    expect(updateErrorDetail(unverified)).toBe(unverified.error)
    expect(updateErrorDetail({ ...unverified, error: 'The update could not be verified.' })).toBeNull()
  })

  it('keeps a missing Mac build as a check failure and shows the release error underneath', () => {
    const update = {
      status: 'error' as const,
      currentVersion: '0.1.4',
      availableVersion: null,
      downloadPercent: null,
      error: 'There is no download for this Mac architecture in the published release.'
    }
    expect(updateCopy(update)).toBe('Could not check for updates.')
    expect(updateErrorDetail(update)).toBe(update.error)
  })

  it('falls back to the installed version when idle', () => {
    expect(
      updateCopy({
        status: 'idle',
        currentVersion: '0.1.4',
        availableVersion: null,
        downloadPercent: null,
        error: null
      })
    ).toBe('This install is 0.1.4.')
  })
})

describe('addonCopy', () => {
  it('says the installed TOC version is current', () => {
    expect(
      addonCopy(
        addonState({
          status: 'current',
          addonsPath: '/wow/Interface/AddOns',
          version: '0.2.0',
          publishedVersion: '0.2.0'
        })
      )
    ).toBe('Everlook 0.2.0 is up to date.')
    expect(addonActionLabel(addonState({ status: 'current', version: '0.2.0' }))).toBeNull()
  })

  it('keeps Update when the TOC version is behind the published tarball', () => {
    expect(
      addonCopy(
        addonState({
          status: 'behind',
          addonsPath: '/wow/Interface/AddOns',
          version: '0.1.0',
          publishedVersion: '0.2.0'
        })
      )
    ).toBe('Everlook 0.1.0 is installed. A newer version is available.')
    expect(addonActionLabel(addonState({ status: 'behind', version: '0.1.0' }))).toBe('Update')
    expect(addonActionName(addonState({ status: 'behind', version: '0.1.0' }), '/wow/Interface/AddOns')).toBe(
      'Update Everlook in /wow/Interface/AddOns'
    )
  })

  it('names a git checkout and hides Install', () => {
    expect(
      addonCopy(
        addonState({
          status: 'git',
          addonsPath: '/wow/Interface/AddOns',
          version: '0.2.0'
        })
      )
    ).toBe('Everlook 0.2.0 is a git checkout in /wow/Interface/AddOns.')
    expect(addonActionLabel(addonState({ status: 'git', version: '0.2.0' }))).toBeNull()
  })

  it('says the addon is missing when idle', () => {
    expect(addonCopy(addonState({ status: 'idle' }))).toBe(
      'Everlook is not in Interface/AddOns yet.'
    )
    expect(addonActionLabel(addonState({ status: 'idle' }))).toBe('Install')
    expect(addonActionName(addonState({ status: 'idle' }), 'this installation')).toBe(
      'Install Everlook in this installation'
    )
    expect(addonActionName(addonState({ status: 'installing' }), '/wow/Interface/AddOns')).toBe(
      'Installing Everlook in /wow/Interface/AddOns'
    )
  })
})

describe('wow launcher copy', () => {
  function wowState(overrides: Partial<WowLauncherState>): WowLauncherState {
    return {
      status: 'idle',
      scriptPath: null,
      error: null,
      ...overrides
    }
  }

  it('labels Launch and Stop from the session state', () => {
    expect(wowLauncherActionLabel(wowState({ status: 'idle' }))).toBe('Launch WoW')
    expect(wowLauncherActionLabel(wowState({ status: 'running' }))).toBe('Stop WoW')
    expect(wowLauncherActionLabel(wowState({ status: 'starting' }))).toBe('Launching…')
    expect(wowLauncherActionLabel(wowState({ status: 'stopping' }))).toBe('Stopping…')
  })

  it('describes the wow.sh Battle.net session', () => {
    expect(wowLauncherCopy(wowState({ status: 'idle' }))).toContain('wow.sh')
    expect(wowLauncherCopy(wowState({ status: 'running' }))).toContain('running')
    expect(wowLauncherCopy(wowState({ status: 'error', error: 'Proton Experimental not found.' }))).toBe(
      'Proton Experimental not found.'
    )
  })
})

describe('formatDate', () => {
  it('returns Never when there is no timestamp', () => {
    expect(formatDate(null)).toBe('Never')
  })

  it('formats an ISO timestamp instead of Never', () => {
    const formatted = formatDate('2026-09-16T12:00:00.000Z', 'en-US')
    expect(formatted).toContain('2026')
    expect(formatted).not.toBe('Never')
  })
})

describe('shortHash', () => {
  it('truncates a sha with an ellipsis', () => {
    expect(shortHash('0123456789abcdef0123')).toBe('0123456789ab…')
  })

  it('labels a missing hash', () => {
    expect(shortHash(null)).toBe('None')
  })
})

describe('file status', () => {
  it('uses plain status labels', () => {
    expect(fileStatusLabel('idle')).toBe('Not watched')
    expect(fileStatusLabel('watching')).toBe('Watching')
    expect(fileStatusLabel('uploading')).toBe('Uploading')
    expect(fileStatusLabel('uploaded')).toBe('Uploaded')
    expect(fileStatusLabel('unchanged')).toBe('Up to date')
    expect(fileStatusLabel('error')).toBe('Failed')
  })
})

describe('credentialNotice', () => {
  it('is silent when the OS keyring is in use', () => {
    expect(credentialNotice('os-keyring')).toBeNull()
  })

  it('explains the 0.1.1 user-file fallback', () => {
    expect(credentialNotice('user-file')).toEqual({
      title: 'Login is saved in a user-only file',
      description: 'This desktop has no OS keyring Everlook can use.'
    })
  })

  it('explains a session-only login', () => {
    expect(credentialNotice('session')?.title).toBe('Login lasts until Everlook closes')
  })
})

const now = new Date('2026-10-01T12:00:00Z')

function file(overrides: Partial<FileState>): FileState {
  return {
    path: '/wow/Everlook.lua',
    account: 'ACCOUNT1',
    lastDetectedAt: null,
    lastUploadedAt: null,
    lastUploadedHash: null,
    status: 'watching',
    error: null,
    response: null,
    signed: null,
    ...overrides
  }
}

describe('relativeTime', () => {
  it('says never for a missing time', () => {
    expect(relativeTime(null, now)).toBe('never')
  })

  it('rounds the last minute to just now', () => {
    expect(relativeTime('2026-10-01T11:59:30Z', now)).toBe('just now')
  })

  it('counts minutes, hours, and days', () => {
    expect(relativeTime('2026-10-01T11:56:00Z', now)).toBe('4 min ago')
    expect(relativeTime('2026-10-01T11:00:00Z', now)).toBe('1 hour ago')
    expect(relativeTime('2026-10-01T09:00:00Z', now)).toBe('3 hours ago')
    expect(relativeTime('2026-09-29T12:00:00Z', now)).toBe('2 days ago')
  })

  it('falls back to a date after a week', () => {
    expect(relativeTime('2026-09-01T12:00:00Z', now, 'en-US')).toBe('Sep 1, 2026')
  })

  it('treats a time in the future as just now', () => {
    expect(relativeTime('2026-10-01T12:05:00Z', now)).toBe('just now')
  })
})

describe('fileStatusTone', () => {
  it('maps each upload status to a dot tone', () => {
    expect(fileStatusTone('error')).toBe('error')
    expect(fileStatusTone('uploading')).toBe('busy')
    expect(fileStatusTone('uploaded')).toBe('ok')
    expect(fileStatusTone('unchanged')).toBe('ok')
    expect(fileStatusTone('watching')).toBe('ok')
    expect(fileStatusTone('idle')).toBe('idle')
  })
})

describe('uploadsSummary', () => {
  it('asks for a file when the list is empty', () => {
    expect(uploadsSummary([], true, now)).toEqual({
      tone: 'idle',
      headline: 'No files yet',
      detail: 'Choose a WoW install or add Everlook.lua files.'
    })
  })

  it('leads with the upload in progress', () => {
    const summary = uploadsSummary(
      [file({ status: 'uploading' }), file({ path: '/b', status: 'watching' })],
      true,
      now
    )
    expect(summary.tone).toBe('busy')
    expect(summary.headline).toBe('Uploading 1 file')
  })

  it('leads with failures over a quiet list', () => {
    const summary = uploadsSummary(
      [file({ status: 'error' }), file({ path: '/b', status: 'error' })],
      true,
      now
    )
    expect(summary.tone).toBe('error')
    expect(summary.headline).toBe('2 files failed to upload')
  })

  it('reports watching files and the latest upload across them', () => {
    const summary = uploadsSummary(
      [
        file({ lastUploadedAt: '2026-10-01T11:00:00Z' }),
        file({ path: '/b', lastUploadedAt: '2026-10-01T11:56:00Z' })
      ],
      true,
      now
    )
    expect(summary).toEqual({
      tone: 'ok',
      headline: 'Watching 2 files',
      detail: 'Last upload 4 min ago.'
    })
  })

  it('says so when automatic upload is off', () => {
    const summary = uploadsSummary([file({})], false, now)
    expect(summary.headline).toBe('1 file, automatic upload off')
    expect(summary.detail).toBe('Nothing uploaded yet.')
  })
})

describe('updateChipLabel', () => {
  const base = {
    currentVersion: '0.4.3',
    availableVersion: '0.4.4',
    downloadPercent: null,
    error: null
  }

  it('stays hidden when there is nothing to act on', () => {
    expect(updateChipLabel({ ...base, status: 'current' })).toBeNull()
    expect(updateChipLabel({ ...base, status: 'checking' })).toBeNull()
    expect(updateChipLabel({ ...base, status: 'error' })).toBeNull()
  })

  it('names each stage of an update', () => {
    expect(updateChipLabel({ ...base, status: 'available' })).toBe('Update found')
    expect(updateChipLabel({ ...base, status: 'downloading', downloadPercent: 40 })).toBe(
      'Downloading 40%'
    )
    expect(updateChipLabel({ ...base, status: 'downloading' })).toBe('Downloading update')
    expect(updateChipLabel({ ...base, status: 'ready' })).toBe('Update ready')
    expect(updateChipLabel({ ...base, status: 'error', error: 'offline' })).toBe('Update failed')
  })
})

describe('signing copy', () => {
  const state = (status: SigningState['status']): SigningState => ({
    status,
    fingerprint: 'ba7816bf',
    placedPath: null,
    error: null
  })

  it('names the fingerprint and the next step', () => {
    expect(signingCopy(state('verified'))).toContain('Verified · ba7816bf')
    expect(signingCopy(state('placed'))).toContain('Waiting for WoW')
    expect(signingCopy(state('stale'))).toContain('Place the token again')
    expect(signingCopy(state('not_placed'))).toContain('Not placed')
  })

  it('offers the button except for dev checkouts', () => {
    expect(signingActionLabel(state('not_placed'))).toBe('Place token')
    expect(signingActionLabel(state('verified'))).toBe('Place again')
    expect(signingActionLabel(state('skipped'))).toBeNull()
    expect(signingActionName(state('not_placed'), '/wow/Interface/AddOns')).toBe(
      'Place signing token in /wow/Interface/AddOns'
    )
    expect(signingActionName(state('verified'), '/wow/Interface/AddOns')).toBe(
      'Place signing token again in /wow/Interface/AddOns'
    )
    expect(signingActionName(state('skipped'), '/wow/Interface/AddOns')).toBeNull()
  })
})

describe('uploadActionName', () => {
  it('names the account so repeated upload buttons are distinct', () => {
    expect(uploadActionName({ account: 'ACCOUNT1', status: 'watching' })).toBe('Upload export for ACCOUNT1')
    expect(uploadActionName({ account: 'ACCOUNT1', status: 'uploading' })).toBe('Uploading export for ACCOUNT1')
  })
})
