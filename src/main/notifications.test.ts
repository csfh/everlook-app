import { describe, expect, it, vi } from 'vitest'
import type { UpdateState } from '../shared/types'
import { createNotifications, updateNotification } from './notifications'

function update(overrides: Partial<UpdateState> = {}): UpdateState {
  return {
    status: 'ready',
    currentVersion: '0.1.0',
    availableVersion: '0.2.0',
    downloadPercent: null,
    error: null,
    ...overrides
  }
}

describe('updateNotification', () => {
  it('notifies when an automatic update is ready to install', () => {
    expect(updateNotification(update())).toEqual({ kind: 'update-ready', version: '0.2.0' })
  })

  it('notifies when a Mac download is listed or already saved', () => {
    expect(updateNotification(update({ status: 'available', mode: 'manual' }))).toEqual({ kind: 'update-available', version: '0.2.0' })
    expect(updateNotification(update({ mode: 'manual' }))).toEqual({ kind: 'update-available', version: '0.2.0' })
  })

  it('stays quiet while an automatic update is still downloading or no version is known', () => {
    expect(updateNotification(undefined)).toBeNull()
    expect(updateNotification(update({ status: 'available' }))).toBeNull()
    expect(updateNotification(update({ status: 'downloading' }))).toBeNull()
    expect(updateNotification(update({ availableVersion: null }))).toBeNull()
  })
})

describe('desktop notifications', () => {
  it('requires the matching preference and OS support, without consuming muted events', () => {
    const show = vi.fn()
    let supported = false
    const notifications = createNotifications({ isSupported: () => supported, show })
    const event = { kind: 'upload-failed' as const, id: 'failure-1' }
    expect(notifications.notify(event, { uploadFailures: true, updates: true })).toBe(false)
    supported = true
    expect(notifications.notify(event, { uploadFailures: false, updates: true })).toBe(false)
    expect(notifications.notify(event, { uploadFailures: true, updates: false })).toBe(true)
    expect(notifications.notify({ kind: 'update-ready', version: '1.0.0' }, { uploadFailures: true, updates: false })).toBe(false)
    expect(show).toHaveBeenCalledTimes(1)
  })

  it('deduplicates failure event IDs and ready versions while allowing subsequent events', () => {
    const show = vi.fn()
    const notifications = createNotifications({ isSupported: () => true, show })
    const preferences = { uploadFailures: true, updates: true }
    expect(notifications.notify({ kind: 'upload-failed', id: 'attempt-1' }, preferences)).toBe(true)
    expect(notifications.notify({ kind: 'upload-failed', id: 'attempt-1' }, preferences)).toBe(false)
    expect(notifications.notify({ kind: 'upload-failed', id: 'attempt-2' }, preferences)).toBe(true)
    expect(notifications.notify({ kind: 'update-ready', version: '1.0.0' }, preferences)).toBe(true)
    expect(notifications.notify({ kind: 'update-ready', version: '1.0.0' }, preferences)).toBe(false)
    expect(notifications.notify({ kind: 'update-ready', version: '1.1.0' }, preferences)).toBe(true)
    expect(show).toHaveBeenCalledTimes(4)
  })

  it('never interpolates event IDs or arbitrary version data into notification text', () => {
    const show = vi.fn()
    const notifications = createNotifications({ isSupported: () => true, show })
    const secret = 'Bearer TOKEN ?X-Amz-Signature=SECRET /home/alice/private'
    notifications.notify({ kind: 'upload-failed', id: secret }, { uploadFailures: true, updates: true })
    notifications.notify({ kind: 'update-ready', version: secret }, { uploadFailures: true, updates: true })
    expect(JSON.stringify(show.mock.calls)).not.toContain(secret)
    expect(show.mock.calls).toEqual([
      [{ title: 'Everlook upload failed', body: 'Open Everlook to review the upload and retry.' }],
      [{ title: 'Everlook update ready', body: 'Open Everlook to install the update and restart.' }]
    ])
  })

  it('propagates port failures and allows another attempt after a failed notification', () => {
    const show = vi.fn().mockImplementationOnce(() => { throw new Error('notification unavailable') }).mockImplementation(() => {})
    const notifications = createNotifications({ isSupported: () => true, show })
    const event = { kind: 'update-ready' as const, version: '1.0.0' }
    expect(() => notifications.notify(event, { updates: true, uploadFailures: false })).toThrow('notification unavailable')
    expect(notifications.notify(event, { updates: true, uploadFailures: false })).toBe(true)
  })

  it('gates and deduplicates manual update availability with safe DMG download copy', () => {
    const show = vi.fn()
    const notifications = createNotifications({ isSupported: () => true, show })
    const event = { kind: 'update-available' as const, version: 'TOKEN?signature=SECRET' }
    expect(notifications.notify(event, { updates: false, uploadFailures: true })).toBe(false)
    expect(notifications.notify(event, { updates: true, uploadFailures: false })).toBe(true)
    expect(notifications.notify(event, { updates: true, uploadFailures: false })).toBe(false)
    expect(show).toHaveBeenCalledExactlyOnceWith({
      title: 'Everlook update available', body: 'Open Everlook to download the macOS DMG.'
    })
  })
})
