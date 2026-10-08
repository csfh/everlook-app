import { mkdtemp, rm, unlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isWatchedWorldFile, WorldFileWatcher } from './watcher'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })))
})

describe('isWatchedWorldFile', () => {
  it('accepts Everlook.lua in a selected SavedVariables folder', () => {
    const selected = ['/wow/WTF/Account/1/SavedVariables/Everlook.lua']
    expect(isWatchedWorldFile('/wow/WTF/Account/1/SavedVariables/Everlook.lua', selected)).toBe(true)
    expect(isWatchedWorldFile('/wow/WTF/Account/1/SavedVariables/Other.lua', selected)).toBe(false)
    expect(isWatchedWorldFile('/wow/WTF/Account/2/SavedVariables/Everlook.lua', selected)).toBe(false)
  })
})

describe('WorldFileWatcher', () => {
  it('uploads after WoW replaces Everlook.lua', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'everlook-watch-'))
    temporaryDirectories.push(directory)
    const filePath = path.join(directory, 'Everlook.lua')
    await writeFile(filePath, 'EverlookDB = {}\n')

    const seen: string[] = []
    const watcher = new WorldFileWatcher(
      async (changed) => {
        seen.push(changed)
      },
      { stabilityThreshold: 50, pollInterval: 20, usePolling: true, interval: 50 }
    )
    await watcher.watch([filePath], true)

    await unlink(filePath)
    await writeFile(filePath, 'EverlookDB = { world = "1c.abc" }\n')

    await expect
      .poll(() => seen.some((entry) => path.resolve(entry) === path.resolve(filePath)), { timeout: 3000 })
      .toBe(true)
    await watcher.close()
  })

  it('uploads an in-place rewrite of Everlook.lua', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'everlook-watch-'))
    temporaryDirectories.push(directory)
    const filePath = path.join(directory, 'Everlook.lua')
    await writeFile(filePath, 'EverlookDB = {}\n')

    const seen: string[] = []
    const watcher = new WorldFileWatcher(
      async (changed) => {
        seen.push(changed)
      },
      { stabilityThreshold: 50, pollInterval: 20, usePolling: true, interval: 50 }
    )
    await watcher.watch([filePath], true)
    await writeFile(filePath, 'EverlookDB = { world = "1r.xyz" }\n')

    await expect
      .poll(() => seen.some((entry) => path.resolve(entry) === path.resolve(filePath)), { timeout: 3000 })
      .toBe(true)
    await watcher.close()
  })

  it('reports a failed upload callback instead of leaving the rejection unhandled', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'everlook-watch-'))
    temporaryDirectories.push(directory)
    const filePath = path.join(directory, 'Everlook.lua')
    await writeFile(filePath, 'EverlookDB = {}\n')
    const rejections: unknown[] = []
    const onRejection = (error: unknown): void => {
      rejections.push(error)
    }
    process.on('unhandledRejection', onRejection)
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const watcher = new WorldFileWatcher(
      async () => {
        throw new Error('queue failed')
      },
      { stabilityThreshold: 50, pollInterval: 20, usePolling: true, interval: 50 }
    )

    try {
      await watcher.watch([filePath], true)
      await writeFile(filePath, 'EverlookDB = { world = "next" }\n')
      await expect.poll(() => logged.mock.calls.length, { timeout: 3000 }).toBeGreaterThan(0)
      await new Promise((resolve) => setTimeout(resolve, 30))
      expect(rejections).toEqual([])
      expect(logged).toHaveBeenCalledWith(
        'Everlook could not queue a world file change.',
        expect.objectContaining({ message: 'queue failed' })
      )
    } finally {
      process.off('unhandledRejection', onRejection)
      logged.mockRestore()
      await watcher.close()
    }
  })
})
