import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_BASE_URL, publicBaseUrl, SettingsStore } from './settings'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })))
})

describe('public Everlook URL', () => {
  it('uses everlook.ing', () => {
    expect(DEFAULT_BASE_URL).toBe('https://everlook.ing')
    expect(publicBaseUrl('https://everlook.ing/')).toBe('https://everlook.ing')
  })

  it('rewrites the former csfh.dev address to the default', () => {
    expect(publicBaseUrl('https://everlook.csfh.dev/')).toBe(DEFAULT_BASE_URL)
    expect(publicBaseUrl('https://everlook.csfh.dev')).toBe(DEFAULT_BASE_URL)
  })

  it('migrates a saved csfh.dev setting on load', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'everlook-settings-'))
    temporaryDirectories.push(directory)
    await writeFile(
      path.join(directory, 'settings.json'),
      JSON.stringify({
        baseUrl: 'https://everlook.csfh.dev',
        autoWatch: true,
        selectedFiles: [],
        uploads: {}
      })
    )

    const store = new SettingsStore(directory)
    const settings = await store.load()

    expect(settings.baseUrl).toBe(DEFAULT_BASE_URL)
    expect(JSON.parse(await readFile(path.join(directory, 'settings.json'), 'utf8')).baseUrl).toBe(
      DEFAULT_BASE_URL
    )
  })

  it('fills wow launcher settings when an older file omits them', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'everlook-settings-'))
    temporaryDirectories.push(directory)
    await writeFile(
      path.join(directory, 'settings.json'),
      JSON.stringify({
        baseUrl: DEFAULT_BASE_URL,
        autoWatch: true,
        selectedFiles: [],
        uploads: {}
      })
    )

    const home = path.join(directory, 'home')
    const store = new SettingsStore(directory, home)
    const settings = await store.load()

    expect(settings.wowLauncher.proton).toContain('GE-Proton11-7-x86_64')
    expect(settings.wowLauncher.inputWidth).toBe(3008)
    expect(settings.wowLauncher.gameMode).toBe(true)
    expect(
      JSON.parse(await readFile(path.join(directory, 'settings.json'), 'utf8')).wowLauncher.prefix
    ).toBe(path.join(home, 'Games', 'battlenet'))
  })
})

describe('close to tray', () => {
  async function directory(): Promise<string> {
    const created = await mkdtemp(path.join(os.tmpdir(), 'everlook-settings-'))
    temporaryDirectories.push(created)
    return created
  }

  it('stays off when an older file omits it', async () => {
    const dir = await directory()
    await writeFile(
      path.join(dir, 'settings.json'),
      JSON.stringify({ baseUrl: DEFAULT_BASE_URL, autoWatch: true, selectedFiles: [], uploads: {} })
    )

    expect((await new SettingsStore(dir).load()).closeToTray).toBe(false)
  })

  it('keeps a saved choice across a reload', async () => {
    const dir = await directory()
    await new SettingsStore(dir).update({ closeToTray: true })

    expect((await new SettingsStore(dir).load()).closeToTray).toBe(true)
  })
})


describe('desktop settings migration', () => {
  it('preserves existing settings while new opt-ins default off and old hashes remain unattributed', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'everlook-settings-'))
    temporaryDirectories.push(directory)
    await writeFile(path.join(directory, 'settings.json'), JSON.stringify({ baseUrl: DEFAULT_BASE_URL, autoWatch: false, closeToTray: true, selectedFiles: ['/world.lua'], uploads: { '/world.lua': { hash: 'a'.repeat(64), uploadedAt: '2026-10-03T00:00:00Z' } } }))
    const settings = await new SettingsStore(directory).load()
    expect(settings).toMatchObject({ autoWatch: false, closeToTray: true, startAtLogin: false, notifications: { uploadFailures: false, updates: false }, selectedFiles: ['/world.lua'], uploadScopes: {}, ignoredFiles: [] })
    expect(settings.uploads['/world.lua']?.hash).toBe('a'.repeat(64))
  })
  it('does not replace a settings file it could not read', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'everlook-settings-'))
    temporaryDirectories.push(directory)
    const file = path.join(directory, 'settings.json')
    const original = '{'
    await writeFile(file, original)
    const store = new SettingsStore(directory)
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      await expect(store.load()).rejects.toThrow('Could not read the saved desktop state.')
      await expect(store.update({ closeToTray: true })).rejects.toThrow('were not replaced')
      expect(await readFile(file, 'utf8')).toBe(original)
    } finally {
      logged.mockRestore()
    }
  })

  it('remembers files the user stopped watching', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'everlook-settings-'))
    temporaryDirectories.push(directory)
    const stopped = '/wow/_forever_/WTF/Account/1/SavedVariables/Everlook.lua'
    await new SettingsStore(directory).update({ ignoredFiles: [stopped] })
    expect((await new SettingsStore(directory).load()).ignoredFiles).toEqual([stopped])
  })

  it('serializes concurrent writes so reload sees the latest combined preferences', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'everlook-settings-'))
    temporaryDirectories.push(directory)
    const store = new SettingsStore(directory)
    await Promise.all([store.update({ startAtLogin: true }), store.update({ closeToTray: true }), store.update({ notifications: { uploadFailures: true, updates: true } })])
    expect(await new SettingsStore(directory).load()).toMatchObject({ startAtLogin: true, closeToTray: true, notifications: { uploadFailures: true, updates: true } })
  })
})
