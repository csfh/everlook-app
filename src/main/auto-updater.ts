import { createRequire } from 'node:module'
import type { AppUpdater } from 'electron-updater'

type ElectronUpdaterModule = {
  autoUpdater: AppUpdater
}

export function loadAutoUpdater(
  requireImpl: (id: string) => unknown = createRequire(import.meta.url)
): AppUpdater {
  const loaded = requireImpl('electron-updater') as ElectronUpdaterModule
  if (loaded?.autoUpdater == null) {
    throw new Error('electron-updater did not export autoUpdater.')
  }
  return loaded.autoUpdater
}
