import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export function renderSignLua(secret: string): string {
  return `local _, Everlook = ...\n\nEverlook.config = Everlook.config or {}\nEverlook.config.token = ${luaString(secret)}\n`
}

function luaString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r/g, '\\r').replace(/\n/g, '\\n')}"`
}

// The short code the addon, the app and the site all show for a signing token.
export const FINGERPRINT_LENGTH = 8

export function signerOf(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex').slice(0, 16)
}

export function fingerprintOf(signerOrSecret: string, isSecret = false): string {
  const signer = isSecret ? signerOf(signerOrSecret) : signerOrSecret
  return signer.slice(0, FINGERPRINT_LENGTH).toLowerCase()
}

export type SigningSecret = { secret: string; signer: string }

export async function requestSigningSecret(
  baseUrl: string,
  token: string,
  request: typeof fetch = fetch
): Promise<SigningSecret> {
  const response = await request(`${baseUrl.replace(/\/$/, '')}/api/desktop/signing-secret`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json'
    }
  })
  if (!response.ok) {
    throw new Error(`Everlook could not issue a signing token (${response.status}).`)
  }
  const body = (await response.json()) as { secret?: unknown; signer?: unknown }
  if (typeof body.secret !== 'string' || body.secret === '') {
    throw new Error('Everlook did not return a signing token.')
  }
  const signer =
    typeof body.signer === 'string' && /^[0-9a-f]{16}$/i.test(body.signer)
      ? body.signer.toLowerCase()
      : signerOf(body.secret)
  return { secret: body.secret, signer }
}

function luaUnstring(value: string): string {
  return value.replace(/\\(["\\rn])/g, (_, escaped: string) =>
    escaped === 'r' ? '\r' : escaped === 'n' ? '\n' : escaped
  )
}

export function signLuaPath(addonsDirectory: string): string {
  return path.join(path.resolve(addonsDirectory), 'Everlook', 'sign.lua')
}

/** The fingerprint of the token in sign.lua, or null when the file has none. */
export async function readPlacedToken(
  addonsDirectory: string
): Promise<{ fingerprint: string } | null> {
  let contents: string
  try {
    contents = await readFile(signLuaPath(addonsDirectory), 'utf8')
  } catch {
    return null
  }
  const match = contents.match(/Everlook\.config\.token\s*=\s*"((?:[^"\\]|\\.)*)"/)
  const secret = match?.[1] === undefined ? '' : luaUnstring(match[1])
  return secret === '' ? null : { fingerprint: fingerprintOf(secret, true) }
}

/** The signer the addon wrote into SavedVariables on its last signed save, if any. */
export async function readSavedSigner(everlookLuaPath: string): Promise<string | null> {
  let contents: string
  try {
    contents = await readFile(everlookLuaPath, 'utf8')
  } catch {
    return null
  }
  const match = contents.match(/\["signer"\]\s*=\s*"([0-9a-fA-F]{16})"/)
  return match?.[1]?.toLowerCase() ?? null
}

/** Development installs may write only to an ignored, untracked sign.lua. */
export async function canWriteSigningToken(addonsDirectory: string): Promise<boolean> {
  const addonDirectory = path.join(path.resolve(addonsDirectory), 'Everlook')
  try {
    const entry = await lstat(addonDirectory)
    const directory = await realpath(addonDirectory)
    try {
      const target = await lstat(path.join(directory, 'sign.lua'))
      if (!target.isFile()) return false
    } catch (error) {
      if (!isMissing(error)) throw error
    }

    if (await hasGitParent(directory)) {
      // check-ignore excludes tracked files from its results by default.
      await execFileAsync('git', ['check-ignore', '--quiet', '--', 'sign.lua'], {
        cwd: directory,
        timeout: 5000
      })
      return true
    }
    return !entry.isSymbolicLink()
  } catch {
    // If protection cannot be verified, the app shows this install as skipped.
    return false
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

async function hasGitParent(directory: string): Promise<boolean> {
  let current = directory
  while (true) {
    try {
      await lstat(path.join(current, '.git'))
      return true
    } catch (error) {
      if (!isMissing(error)) throw error
    }
    const parent = path.dirname(current)
    if (parent === current) return false
    current = parent
  }
}

export async function writeSigningToken(addonsDirectory: string, secret: string): Promise<string> {
  const addonDirectory = path.join(path.resolve(addonsDirectory), 'Everlook')
  const target = path.join(addonDirectory, 'sign.lua')
  await mkdir(addonDirectory, { recursive: true })
  if (!(await canWriteSigningToken(addonsDirectory))) {
    throw new Error('Signing token file is protected. In a dev checkout, sign.lua must be ignored and untracked.')
  }
  await writeFile(target, renderSignLua(secret), { encoding: 'utf8', mode: 0o600 })
  await chmod(target, 0o600)
  return target
}
