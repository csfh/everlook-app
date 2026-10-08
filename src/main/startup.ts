import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

export type StartupState = { supported: boolean; enabled: boolean; error: string | null }
export type StartupOptions = {
  platform: NodeJS.Platform
  packaged: boolean
  executable: string
  homeDirectory: string
  configDirectory?: string
  setLoginItemSettings?: (settings: { openAtLogin: boolean; enabled?: boolean; path?: string; args?: string[] }) => void
  getLoginItemSettings?: (options?: { path?: string; args?: string[] }) => {
    openAtLogin: boolean
    executableWillLaunchAtLogin?: boolean
    status?: string
  }
}

export async function readStartup(options: StartupOptions): Promise<StartupState> {
  if (!supported(options)) return { supported: false, enabled: false, error: null }
  try {
    if (options.platform !== 'linux') return readNativeStartup(options)
    const file = desktopFile(options)
    let contents: string
    try {
      contents = await readFile(file, 'utf8')
    } catch (error) {
      if (hasCode(error, 'ENOENT')) return state(false)
      throw error
    }
    const lines = contents.split(/\r?\n/).map((line) => line.trim())
    if (lines.includes('Hidden=true') || lines.includes('X-GNOME-Autostart-enabled=false')) return state(false)
    const expected = `Exec=${quoteDesktopExecutable(options.executable)} --background`
    if (!lines.includes('[Desktop Entry]') || !lines.includes('Type=Application') || !lines.includes(expected)) {
      return state(false, 'The startup entry does not match this Everlook installation. Turn startup on again to replace it.')
    }
    return state(true)
  } catch (error) {
    return state(false, failureMessage('read', error))
  }
}

export async function configureStartup(options: StartupOptions & { enabled: boolean }): Promise<StartupState> {
  if (!supported(options)) {
    return { supported: false, enabled: false, error: options.enabled ? 'Start at login is unavailable for this platform or development build.' : null }
  }
  const previous = await readStartup(options)
  try {
    if (options.platform === 'linux') {
      const file = desktopFile(options)
      if (options.enabled) {
        const contents = [
          '[Desktop Entry]', 'Type=Application', 'Name=Everlook',
          `Exec=${quoteDesktopExecutable(options.executable)} --background`,
          'Terminal=false', 'Hidden=false', 'X-GNOME-Autostart-enabled=true', ''
        ].join('\n')
        const directory = path.dirname(file)
        await mkdir(directory, { recursive: true })
        const staging = await mkdtemp(path.join(directory, '.everlook-'))
        try {
          const temporary = path.join(staging, 'startup.desktop')
          await writeFile(temporary, contents, { mode: 0o600 })
          await rename(temporary, file)
        } finally {
          await rm(staging, { recursive: true, force: true })
        }
      } else {
        await rm(file, { force: true })
      }
    } else {
      if (options.setLoginItemSettings === undefined || options.getLoginItemSettings === undefined) {
        throw new Error('Electron login item settings are unavailable.')
      }
      options.setLoginItemSettings(options.platform === 'win32'
        ? { openAtLogin: options.enabled, enabled: options.enabled, ...windowsLoginOptions(options) }
        : { openAtLogin: options.enabled })
    }
    const observed = await readStartup(options)
    if (observed.error !== null || observed.enabled === options.enabled) return observed
    return { ...observed, error: 'The operating system did not apply the requested login startup setting. Check your startup settings.' }
  } catch (error) {
    return state(previous.enabled, failureMessage('change', error))
  }
}

function supported(options: StartupOptions): boolean {
  return options.packaged && ['linux', 'win32', 'darwin'].includes(options.platform)
}

function state(enabled: boolean, error: string | null = null): StartupState {
  return { supported: true, enabled, error }
}

function desktopFile(options: StartupOptions): string {
  const configDirectory = options.configDirectory ?? path.posix.join(options.homeDirectory, '.config')
  if (!path.posix.isAbsolute(configDirectory) || hasControlCharacter(configDirectory)) {
    throw new Error('The startup configuration directory must be an absolute path without control characters.')
  }
  return path.posix.join(configDirectory, 'autostart', 'dev.csfh.everlook.desktop')
}

function quoteDesktopExecutable(executable: string): string {
  if (!path.posix.isAbsolute(executable) || executable.includes('=') || hasControlCharacter(executable)) {
    throw new Error('The startup executable must be an absolute path without equals signs or control characters.')
  }
  // Desktop values are unescaped once before Exec quoting is parsed, then field codes expand.
  const quoted = executable.replaceAll('%', '%%').replace(/["`$\\]/g, (character) => `\\${character}`)
  return `"${quoted.replaceAll('\\', '\\\\')}"`
}

function windowsLoginOptions(options: StartupOptions): { path: string; args: string[] } {
  if (!(path.win32.isAbsolute(options.executable) || path.posix.isAbsolute(options.executable)) || hasControlCharacter(options.executable)) {
    throw new Error('The startup executable must be an absolute path without control characters.')
  }
  return { path: options.executable, args: ['--background'] }
}

function readNativeStartup(options: StartupOptions): StartupState {
  if (options.getLoginItemSettings === undefined) throw new Error('Electron login item settings are unavailable.')
  const settings = options.platform === 'win32'
    ? options.getLoginItemSettings(windowsLoginOptions(options))
    : options.getLoginItemSettings()
  if (options.platform === 'darwin' && settings.status === 'requires-approval') {
    return state(false, 'Allow Everlook in System Settings → General → Login Items to enable startup.')
  }
  if (options.platform === 'darwin' && settings.status === 'not-found') {
    return state(false, 'macOS could not find the Everlook login item. Reinstall the packaged app and try again.')
  }
  if (options.platform === 'win32' && settings.openAtLogin && settings.executableWillLaunchAtLogin === false) {
    return state(false, 'Everlook startup is disabled in Windows startup settings.')
  }
  return state(settings.openAtLogin)
}

function hasCode(error: unknown, code: string): boolean {
  return error !== null && typeof error === 'object' && 'code' in error && error.code === code
}

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
}

function failureMessage(action: 'read' | 'change', error: unknown): string {
  if (hasCode(error, 'EACCES') || hasCode(error, 'EPERM')) {
    return `Could not ${action} Everlook startup settings. Check your login settings and directory permissions.`
  }
  if (hasCode(error, 'ENOTDIR') || hasCode(error, 'EROFS')) {
    return `Could not ${action} Everlook startup settings. The configuration directory is not writable.`
  }
  // Validation and missing-port errors contain only our own text; OS exceptions may include private paths.
  if (error instanceof Error && (error.message.startsWith('The startup ') || error.message === 'Electron login item settings are unavailable.')) return error.message
  return `Could not ${action} Everlook startup settings. Check your operating system startup settings.`
}
