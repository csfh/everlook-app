import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { updateDataPack } from './data-pack'

const sha = (text: string): string => createHash('sha256').update(text).digest('hex')

const META = (version: string): string => `Everlook_Data.meta = { version = "${version}", built = "2026-10-15", kinds = { drops = { 117 } } }\n`
const CHUNK = '-- chunk\nEverlook_Data.chunk("drops", 117, [==[\n\n117|1:2:Boar\n]==])\n'
const TOC = '## Interface: 16001\ndata.lua\nmeta.lua\ndrops_1.lua\n'

function pack(version: string, overrides: Record<string, string> = {}): Record<string, string> {
  return { 'Everlook_Data.toc': TOC, 'meta.lua': META(version), 'drops_1.lua': CHUNK, ...overrides }
}

function site(files: Record<string, string>, lie: Record<string, string> = {}) {
  const version = /version = "([0-9a-f]{12})"/.exec(files['meta.lua'] ?? '')?.[1] ?? 'x'
  const manifest = { version, built: '2026-10-15', files: Object.entries(files).map(([name, text]) => ({ name, sha256: sha(text), bytes: Buffer.byteLength(text) })) }
  return vi.fn<typeof fetch>(async (input) => {
    const url = String(input)
    if (url.endsWith('/download/data-pack.json')) return new Response(JSON.stringify(manifest), { status: 200 })
    const name = url.split('/').pop() ?? ''
    if (name in lie) return new Response(lie[name], { status: 200 })
    return name in files ? new Response(files[name], { status: 200 }) : new Response('no', { status: 404 })
  })
}

let addons: string

async function installAddon(options: { data?: boolean; hand?: boolean } = {}): Promise<string> {
  await mkdir(path.join(addons, 'Everlook'), { recursive: true })
  await writeFile(path.join(addons, 'Everlook', 'Everlook.toc'), '## Interface: 16001\n## Title: Everlook\n## Version: 0.30.0\nworld.lua\n')
  await writeFile(path.join(addons, 'Everlook', 'world.lua'), '')
  const data = path.join(addons, 'Everlook_Data')
  if (options.data !== false) {
    await mkdir(data, { recursive: true })
    if (options.hand !== false) await writeFile(path.join(data, 'data.lua'), '-- the addon\'s own reader\n')
  }
  return data
}

beforeEach(async () => {
  addons = await mkdtemp(path.join(os.tmpdir(), 'everlook-datapack-'))
})
afterEach(async () => {
  await rm(addons, { recursive: true, force: true })
})

describe('updateDataPack', () => {
  it('writes the listed files beside data.lua, meta last, and keeps the addon\'s own reader', async () => {
    const data = await installAddon()
    const result = await updateDataPack({ baseUrl: 'https://everlook.example', addonsDirectory: addons, fetchImpl: site(pack('aaaaaaaaaaaa')) })

    expect(result).toBe('updated')
    expect((await readdir(data)).sort()).toEqual(['Everlook_Data.toc', 'data.lua', 'drops_1.lua', 'meta.lua'])
    expect(await readFile(path.join(data, 'meta.lua'), 'utf8')).toBe(META('aaaaaaaaaaaa'))
    expect(await readFile(path.join(data, 'data.lua'), 'utf8')).toContain('own reader')
  })

  it('does nothing when the version is already there, and downloads no file', async () => {
    await installAddon()
    const fetchImpl = site(pack('aaaaaaaaaaaa'))
    await updateDataPack({ baseUrl: 'https://everlook.example', addonsDirectory: addons, fetchImpl })
    fetchImpl.mockClear()

    expect(await updateDataPack({ baseUrl: 'https://everlook.example', addonsDirectory: addons, fetchImpl })).toBe('current')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('replaces a new version and removes a chunk the pack no longer lists', async () => {
    const data = await installAddon()
    await updateDataPack({ baseUrl: 'https://everlook.example', addonsDirectory: addons, fetchImpl: site(pack('aaaaaaaaaaaa', { 'entrances_1.lua': CHUNK })) })
    expect(await readdir(data)).toContain('entrances_1.lua')

    await updateDataPack({ baseUrl: 'https://everlook.example', addonsDirectory: addons, fetchImpl: site(pack('bbbbbbbbbbbb')) })
    expect(await readdir(data)).not.toContain('entrances_1.lua')
    expect(await readFile(path.join(data, 'meta.lua'), 'utf8')).toContain('bbbbbbbbbbbb')
  })

  it('writes nothing when one file does not match its digest', async () => {
    const data = await installAddon()
    const files = pack('aaaaaaaaaaaa')
    await expect(updateDataPack({ baseUrl: 'https://everlook.example', addonsDirectory: addons, fetchImpl: site(files, { 'drops_1.lua': 'tampered' }) })).rejects.toThrow('digest')
    expect(await readdir(data)).toEqual(['data.lua'])
  })

  it('refuses a manifest that names a path, data.lua, or too much', async () => {
    await installAddon()
    for (const bad of [
      { 'Everlook_Data.toc': TOC, 'meta.lua': META('aaaaaaaaaaaa'), '../escape.lua': 'x' },
      { 'Everlook_Data.toc': TOC, 'meta.lua': META('aaaaaaaaaaaa'), 'data.lua': 'replaced' },
      { 'Everlook_Data.toc': TOC, 'drops_1.lua': CHUNK }
    ]) {
      await expect(updateDataPack({ baseUrl: 'https://everlook.example', addonsDirectory: addons, fetchImpl: site(bad) })).rejects.toThrow()
    }
    expect((await readdir(path.join(addons, 'Everlook_Data'))).sort()).toEqual(['data.lua'])
  })

  it('skips an installation without the addon, a data folder without data.lua, a linked folder and a git checkout', async () => {
    const fetchImpl = site(pack('aaaaaaaaaaaa'))
    expect(await updateDataPack({ baseUrl: 'https://everlook.example', addonsDirectory: addons, fetchImpl })).toBe('skipped')

    await installAddon({ hand: false })
    expect(await updateDataPack({ baseUrl: 'https://everlook.example', addonsDirectory: addons, fetchImpl })).toBe('skipped')

    await rm(path.join(addons, 'Everlook_Data'), { recursive: true })
    // A link needs a privilege on Windows, so the check runs where links are ordinary.
    if (process.platform !== 'win32') {
      const elsewhere = await mkdtemp(path.join(os.tmpdir(), 'everlook-elsewhere-'))
      await writeFile(path.join(elsewhere, 'data.lua'), '')
      await symlink(elsewhere, path.join(addons, 'Everlook_Data'))
      expect(await updateDataPack({ baseUrl: 'https://everlook.example', addonsDirectory: addons, fetchImpl })).toBe('skipped')
      await rm(elsewhere, { recursive: true, force: true })
      await rm(path.join(addons, 'Everlook_Data'), { force: true })
    }
    await mkdir(path.join(addons, 'Everlook_Data'))
    await writeFile(path.join(addons, 'Everlook_Data', 'data.lua'), '')
    await mkdir(path.join(addons, 'Everlook', '.git'))
    expect(await updateDataPack({ baseUrl: 'https://everlook.example', addonsDirectory: addons, fetchImpl })).toBe('skipped')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('says when the site does not answer', async () => {
    await installAddon()
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response('down', { status: 503 }))
    await expect(updateDataPack({ baseUrl: 'https://everlook.example', addonsDirectory: addons, fetchImpl })).rejects.toThrow('503')
  })
})
