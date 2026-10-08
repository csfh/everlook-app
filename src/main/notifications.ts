import type { UpdateState } from '../shared/types'

export type NotificationPreferences = { uploadFailures: boolean; updates: boolean }
export type NotificationEvent =
  | { kind: 'upload-failed'; id: string }
  | { kind: 'update-ready'; version: string }
  | { kind: 'update-available'; version: string }
export type NotificationPort = {
  isSupported: () => boolean
  show: (notification: { title: string; body: string }) => void
}

/** An automatic update notifies once it is ready. A Mac download notifies as soon as it is listed. */
export function updateNotification(update: UpdateState | undefined): NotificationEvent | null {
  if (!update?.availableVersion) return null
  const ready = update.status === 'ready'
  const manualDownload = update.mode === 'manual' && update.status === 'available'
  if (!ready && !manualDownload) return null
  return {
    kind: update.mode === 'manual' ? 'update-available' : 'update-ready',
    version: update.availableVersion
  }
}

export function createNotifications(port: NotificationPort): {
  notify: (event: NotificationEvent, preferences: NotificationPreferences) => boolean
} {
  const seen = new Set<string>()
  return {
    notify(event, preferences) {
      const enabled = event.kind === 'upload-failed' ? preferences.uploadFailures : preferences.updates
      if (!enabled || !port.isSupported()) return false
      const key = event.kind === 'upload-failed' ? `upload:${event.id}` : `update:${event.version}`
      if (seen.has(key)) return false
      port.show(event.kind === 'upload-failed'
        ? { title: 'Everlook upload failed', body: 'Open Everlook to review the upload and retry.' }
        : event.kind === 'update-available'
          ? { title: 'Everlook update available', body: 'Open Everlook to download the macOS DMG.' }
          : { title: 'Everlook update ready', body: 'Open Everlook to install the update and restart.' })
      seen.add(key)
      return true
    }
  }
}
