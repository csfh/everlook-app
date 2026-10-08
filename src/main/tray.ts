import path from 'node:path'
import { app, Menu, nativeImage, Tray } from 'electron'
import type { AppState } from '../shared/types'
import { buildTrayMenu, trayStatus, type TrayHandlers } from './tray-menu'

export type EverlookTray = {
  update: (state: AppState) => void
  destroy: () => void
}

function trayIconPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'tray.png')
    : path.join(app.getAppPath(), 'build/tray.png')
}

export function createTray(handlers: TrayHandlers): EverlookTray {
  const icon = nativeImage.createFromPath(trayIconPath()).resize({ width: 22, height: 22 })
  if (process.platform === 'darwin') icon.setTemplateImage(true)
  const tray = new Tray(icon)
  tray.on('click', handlers.open)

  return {
    update(state) {
      const status = trayStatus(state)
      tray.setToolTip(`Everlook: ${status.label}`)
      tray.setContextMenu(Menu.buildFromTemplate(buildTrayMenu(status, handlers)))
    },
    destroy() {
      tray.destroy()
    }
  }
}
