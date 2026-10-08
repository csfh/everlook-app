import { contextBridge, ipcRenderer } from 'electron'
import type { AppState, EverlookApi, IpcChannel, IpcResult } from '../shared/types'

function invoke<C extends IpcChannel>(channel: C, payload?: unknown): Promise<IpcResult<C>> {
  return ipcRenderer.invoke(channel, payload)
}

const api: EverlookApi = {
  refreshInstallations: () => invoke('installs:refresh'),
  chooseNativeLauncher: () => invoke('launcher:choose'),
  openNativeLauncher: () => invoke('launcher:open'),
  retryFile: (path) => invoke('uploads:retry', { path }),
  openSecuritySettings: (url) => invoke('security:open', { url }),
  exportDiagnostics: () => invoke('diagnostics:export'),
  getState: () => invoke('state:get'),
  chooseRoot: () => invoke('files:choose-root'),
  chooseFiles: () => invoke('files:choose'),
  removeFile: (path: string) => invoke('files:remove', { path }),
  updateSettings: (settings) =>
    invoke('settings:update', settings),
  login: () => invoke('auth:login'),
  logout: () => invoke('auth:logout'),
  uploadFile: (path: string) => invoke('uploads:file', { path }),
  uploadAll: () => invoke('uploads:all'),
  checkForUpdates: () => invoke('updates:check'),
  installUpdate: () => invoke('updates:install'),
  installAddon: (addonsPath) => invoke('addon:install', { addonsPath }),
  placeSigningToken: (addonsPath) => invoke('addon:sign', { addonsPath }),
  launchWow: () => invoke('wow:launch'),
  stopWow: () => invoke('wow:stop'),
  onState: (listener: (state: AppState) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, nextState: AppState): void => listener(nextState)
    ipcRenderer.on('state:changed', handler)
    return () => ipcRenderer.removeListener('state:changed', handler)
  },
  minimizeWindow: () => invoke('window:minimize'),
  maximizeWindow: () => invoke('window:maximize'),
  closeWindow: () => invoke('window:close'),
  isWindowMaximized: () => invoke('window:is-maximized'),
  onWindowMaximized: (listener: (maximized: boolean) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, maximized: boolean): void =>
      listener(maximized)
    ipcRenderer.on('window:maximized', handler)
    return () => ipcRenderer.removeListener('window:maximized', handler)
  }
}

contextBridge.exposeInMainWorld('everlook', api)
