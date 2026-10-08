import { describe, expect, it, vi } from 'vitest'
import type { AppUpdater } from 'electron-updater'
import { loadAutoUpdater } from './auto-updater'

function fakeAutoUpdater(): AppUpdater {
  return { checkForUpdates: vi.fn() } as unknown as AppUpdater
}

describe('loadAutoUpdater', () => {
  it('reads autoUpdater from the CommonJS module object', () => {
    const autoUpdater = fakeAutoUpdater()
    const requireImpl = vi.fn(() => ({ autoUpdater }))
    expect(loadAutoUpdater(requireImpl)).toBe(autoUpdater)
    expect(requireImpl).toHaveBeenCalledWith('electron-updater')
  })

  it('rejects a module that has no autoUpdater export', () => {
    expect(() => loadAutoUpdater(() => ({}) as never)).toThrow(
      'electron-updater did not export autoUpdater.'
    )
  })
})
