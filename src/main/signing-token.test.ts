import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import {
  fingerprintOf,
  readPlacedToken,
  readSavedSigner,
  renderSignLua,
  requestSigningSecret,
  signerOf,
  writeSigningToken
} from './signing-token'

const execFileAsync = promisify(execFile)

async function developmentInstall(ignored: boolean, linked = true) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'everlook-sign-dev-'))
  const repo = path.join(root, 'repo')
  const addon = path.join(repo, linked ? 'addon' : 'Everlook')
  const addons = linked ? path.join(root, 'AddOns') : repo
  await mkdir(addon, { recursive: true })
  await execFileAsync('git', ['init', '--quiet', repo])
  if (ignored) await writeFile(path.join(repo, '.gitignore'), `/${linked ? 'addon' : 'Everlook'}/sign.lua\n`)
  await writeFile(path.join(addon, 'sign.lua'), '-- clean stub\n')
  if (linked) {
    await mkdir(addons)
    await symlink(addon, path.join(addons, 'Everlook'), process.platform === 'win32' ? 'junction' : 'dir')
  }
  return { repo, addon, addons }
}

describe('signing token', () => {
  it('quotes the token as a Lua string', () => {
    expect(renderSignLua('a"b\\c')).toContain('Everlook.config.token = "a\\"b\\\\c"')
  })

  it('writes sign.lua into the Everlook addon folder', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'everlook-sign-'))
    const written = await writeSigningToken(root, 'token-value')
    expect(written).toBe(path.join(root, 'Everlook', 'sign.lua'))
    expect(await readFile(written, 'utf8')).toContain('token-value')
    if (process.platform !== 'win32') expect((await stat(written)).mode & 0o777).toBe(0o600)
  })

  it('writes through a symlink when sign.lua is ignored and untracked', async () => {
    const { addon, addons } = await developmentInstall(true)
    await writeSigningToken(addons, 'local-token')
    expect(await readFile(path.join(addon, 'sign.lua'), 'utf8')).toContain('local-token')
    expect(await readPlacedToken(addons)).toEqual({ fingerprint: fingerprintOf('local-token', true) })
  })

  it('refuses an unignored sign.lua in a symlinked checkout', async () => {
    const { addon, addons } = await developmentInstall(false)
    await expect(writeSigningToken(addons, 'secret')).rejects.toThrow('protected')
    expect(await readFile(path.join(addon, 'sign.lua'), 'utf8')).toBe('-- clean stub\n')
  })

  it('refuses a tracked sign.lua even when an ignore rule matches', async () => {
    const { repo, addon, addons } = await developmentInstall(true)
    await execFileAsync('git', ['-C', repo, 'add', '-f', 'addon/sign.lua'])
    await expect(writeSigningToken(addons, 'secret')).rejects.toThrow('protected')
    expect(await readFile(path.join(addon, 'sign.lua'), 'utf8')).toBe('-- clean stub\n')
  })

  it('checks a direct checkout whose .git directory lives in a parent', async () => {
    const { addon, addons } = await developmentInstall(false, false)
    await expect(writeSigningToken(addons, 'secret')).rejects.toThrow('protected')
    expect(await readFile(path.join(addon, 'sign.lua'), 'utf8')).toBe('-- clean stub\n')
  })

  it('allows an ignored sign.lua in a direct checkout', async () => {
    const { addon, addons } = await developmentInstall(true, false)
    await writeSigningToken(addons, 'local-token')
    expect(await readFile(path.join(addon, 'sign.lua'), 'utf8')).toContain('local-token')
  })

  it('refuses a sign.lua that is itself a symlink', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'everlook-sign-link-'))
    const outside = path.join(root, 'tracked.lua')
    await writeFile(outside, '-- protected\n')
    await mkdir(path.join(root, 'Everlook'))
    await symlink(outside, path.join(root, 'Everlook', 'sign.lua'), 'file')
    await expect(writeSigningToken(root, 'secret')).rejects.toThrow('protected')
    expect(await readFile(outside, 'utf8')).toBe('-- protected\n')
  })

  it('reads the secret from the desktop API', async () => {
    const secret = await requestSigningSecret('https://everlook.test', 'desktop', async () => {
      return new Response(JSON.stringify({ secret: 'issued' }), { status: 200 })
    })
    expect(secret).toEqual({ secret: 'issued', signer: signerOf('issued') })
  })

  it('uses the signer the server returns', async () => {
    const result = await requestSigningSecret('https://everlook.test', 'desktop', async () => {
      return new Response(JSON.stringify({ secret: 'issued', signer: 'ABCDEF0123456789' }), { status: 200 })
    })
    expect(result.signer).toBe('abcdef0123456789')
  })

  it('matches the signer the addon and server derive', () => {
    // sha256("abc") starts ba7816bf8f01cfea
    expect(signerOf('abc')).toBe('ba7816bf8f01cfea')
    expect(fingerprintOf('abc', true)).toBe('ba7816bf')
    expect(fingerprintOf('ba7816bf8f01cfea')).toBe('ba7816bf')
  })

  it('reads back the fingerprint of the placed token', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'everlook-sign-'))
    expect(await readPlacedToken(root)).toBeNull()
    await mkdir(path.join(root, 'Everlook'))
    await writeFile(path.join(root, 'Everlook', 'sign.lua'), '-- stub\nEverlook.config = {}\n')
    expect(await readPlacedToken(root)).toBeNull()
    await writeSigningToken(root, 'a"b\\c')
    expect(await readPlacedToken(root)).toEqual({ fingerprint: fingerprintOf('a"b\\c', true) })
  })

  it('reads the signer from SavedVariables', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'everlook-sv-'))
    const file = path.join(root, 'Everlook.lua')
    expect(await readSavedSigner(file)).toBeNull()
    await writeFile(file, 'EverlookDB = {\n["world"] = "1c.QUJD",\n["signer"] = "BA7816BF8F01CFEA",\n}\n')
    expect(await readSavedSigner(file)).toBe('ba7816bf8f01cfea')
    await writeFile(file, 'EverlookDB = { ["world"] = "x" }')
    expect(await readSavedSigner(file)).toBeNull()
  })
})
