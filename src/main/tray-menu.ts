import type { MenuItemConstructorOptions } from 'electron'
import type { AppState, WowLauncherStatus } from '../shared/types'
import { uploadsSummary } from '../shared/upload-summary'

export type TrayStatus = {
  label: string
  canUpload: boolean
  native?: boolean
  wow: WowLauncherStatus
}

export type TrayHandlers = {
  uploadAll: () => void
  toggleWow: () => void
  open: () => void
  quit: () => void
}

export function trayStatus(
  state: Pick<AppState, 'authenticated' | 'files' | 'settings' | 'wow' | 'capabilities'>
): TrayStatus {
  const summary = uploadsSummary(state.files, state.settings.autoWatch)
  return {
    label: state.authenticated ? summary.headline : 'Signed out',
    canUpload:
      state.authenticated &&
      state.files.length > 0 &&
      !state.files.some((file) => file.status === 'uploading'),
    native: state.capabilities?.nativeBattleNet ?? false,
    wow: state.wow.status
  }
}

function wowItem(wow: WowLauncherStatus, toggle: () => void): MenuItemConstructorOptions {
  if (wow === 'starting') return { label: 'Launching…', enabled: false }
  if (wow === 'stopping') return { label: 'Stopping…', enabled: false }
  return { label: wow === 'running' ? 'Stop WoW' : 'Launch WoW', enabled: true, click: toggle }
}

export function buildTrayMenu(
  status: TrayStatus,
  handlers: TrayHandlers
): MenuItemConstructorOptions[] {
  return [
    { label: status.label, enabled: false },
    { type: 'separator' },
    { label: 'Upload all', enabled: status.canUpload, click: handlers.uploadAll },
    status.native ? { label: 'Open Battle.net', click: handlers.toggleWow } : wowItem(status.wow, handlers.toggleWow),
    { type: 'separator' },
    { label: 'Open Everlook', click: handlers.open },
    { label: 'Quit Everlook', click: handlers.quit }
  ]
}
