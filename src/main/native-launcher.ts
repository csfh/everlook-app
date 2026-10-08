import { constants } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import path from 'node:path'

export type NativeLauncherFileSystem = {
  stat: (candidate: string) => Promise<{ isFile: () => boolean; isDirectory: () => boolean }>
  access: (candidate: string, mode: number) => Promise<void>
}

export type NativeLauncherOptions = {
  platform: NodeJS.Platform
  path: string
  fileSystem?: NativeLauncherFileSystem
}

export type NativeLaunchResult = { status: 'opened'; path: string }

export async function validateNativeLauncher(options: NativeLauncherOptions): Promise<string> {
  if (options.platform !== 'win32' && options.platform !== 'darwin') {
    throw new Error('Native Battle.net launch is available on Windows and macOS only.')
  }
  const candidate = options.path
  if (candidate === '' || hasControlCharacter(candidate)) {
    throw new Error('Choose a valid Battle.net launcher path.')
  }
  const absolute = options.platform === 'win32'
    ? path.win32.isAbsolute(candidate) || path.posix.isAbsolute(candidate)
    : path.posix.isAbsolute(candidate)
  if (!absolute) throw new Error('Choose an absolute path to the Battle.net launcher.')
  if (options.platform === 'win32' && path.extname(candidate).toLowerCase() !== '.exe') {
    throw new Error('Choose the Battle.net .exe executable file.')
  }
  if (options.platform === 'darwin' && path.posix.extname(candidate).toLowerCase() !== '.app') {
    throw new Error('Choose the Battle.net .app directory.')
  }

  const fileSystem = options.fileSystem ?? { stat, access }
  let metadata: Awaited<ReturnType<NativeLauncherFileSystem['stat']>>
  try {
    metadata = await fileSystem.stat(candidate)
  } catch (error) {
    if (hasCode(error, 'ENOENT') || hasCode(error, 'ENOTDIR')) {
      throw new Error('The Battle.net launcher was not found. Choose its installed location.', { cause: error })
    }
    throw new Error('The Battle.net launcher could not be inspected. Check its permissions.', { cause: error })
  }
  if (options.platform === 'win32' && !metadata.isFile()) {
    throw new Error('Choose a regular Battle.net executable file.')
  }
  if (options.platform === 'darwin' && !metadata.isDirectory()) {
    throw new Error('The Battle.net .app must be an application directory.')
  }
  try {
    await fileSystem.access(candidate, constants.R_OK)
  } catch (error) {
    throw new Error('The Battle.net launcher is not readable. Check its permissions.', { cause: error })
  }
  return candidate
}

export async function launchNativeBattleNet(options: NativeLauncherOptions & {
  openPath: (candidate: string) => Promise<string>
}): Promise<NativeLaunchResult> {
  const candidate = await validateNativeLauncher(options)
  const error = await options.openPath(candidate)
  if (error !== '') throw new Error(`Could not open Battle.net: ${error}`)
  return { status: 'opened', path: candidate }
}

export async function discoverNativeLauncher(options: {
  platform: NodeJS.Platform
  homeDirectory: string
  env?: NodeJS.ProcessEnv
  fileSystem?: NativeLauncherFileSystem
}): Promise<string | null> {
  const candidates: string[] = []
  if (options.platform === 'win32') {
    const env = options.env ?? process.env
    const entries = Object.entries(env)
    for (const [key, fallback] of [['programfiles', 'C:\\Program Files'], ['programfiles(x86)', 'C:\\Program Files (x86)']]) {
      const base = entries.find(([name]) => name.toLowerCase() === key)?.[1] || fallback
      if (base === undefined) continue
      for (const name of ['Battle.net Launcher.exe', 'Battle.net.exe']) {
        candidates.push(path.win32.join(base, 'Battle.net', name))
      }
    }
  } else if (options.platform === 'darwin') {
    candidates.push('/Applications/Battle.net.app', path.posix.join(options.homeDirectory, 'Applications', 'Battle.net.app'))
  }
  for (const candidate of new Set(candidates)) {
    try {
      return await validateNativeLauncher({
        platform: options.platform,
        path: candidate,
        ...(options.fileSystem === undefined ? {} : { fileSystem: options.fileSystem })
      })
    } catch {
      // Missing or unusable discovery candidates are skipped; a selected path reports its error.
    }
  }
  return null
}

function hasCode(error: unknown, code: string): boolean {
  return error !== null && typeof error === 'object' && 'code' in error && error.code === code
}

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
}
