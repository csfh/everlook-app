import { describe, expect, it, vi } from 'vitest'
import { ManualUpdater } from './manual-updater'

function release(arch = 'arm64') {
  return new Response(JSON.stringify({
    version: '0.6.0', artifacts: [
      { id: `macos-${arch}`, platform: 'darwin', arch, filename: `Everlook-0.6.0-mac-${arch}.dmg`, size: 200, sha256: 'a'.repeat(64), url: 'https://malicious.example/file' }
    ]
  }))
}
describe('unsigned Mac updates', () => {
  it('offers the matching architecture through the configured site and never opens it automatically', async () => {
    const openExternal = vi.fn()
    const updater = new ManualUpdater({ currentVersion: '0.5.0', baseUrl: () => 'https://everlook.example', arch: 'arm64', request: vi.fn<typeof fetch>().mockResolvedValue(release()), openExternal, onState: vi.fn() })
    await updater.check()
    expect(updater.getState()).toMatchObject({ mode: 'manual', status: 'available', availableVersion: '0.6.0', downloadUrl: 'https://everlook.example/download/macos-arm64' })
    expect(openExternal).not.toHaveBeenCalled()
    await updater.install()
    expect(openExternal).toHaveBeenCalledWith('https://everlook.example/download/macos-arm64')
  })
  it('does not offer an Intel download to an Apple Silicon Mac', async () => {
    const updater = new ManualUpdater({ currentVersion: '0.5.0', baseUrl: () => 'https://everlook.example', arch: 'arm64', request: vi.fn<typeof fetch>().mockResolvedValue(release('x64')), openExternal: vi.fn(), onState: vi.fn() })
    await updater.check()
    expect(updater.getState()).toMatchObject({
      status: 'error',
      error: 'There is no download for this Mac architecture in the published release.'
    })
    await expect(updater.install()).rejects.toThrow('Check for an available update')
  })
  it('keeps the HTTP status when the release manifest cannot be read', async () => {
    const updater = new ManualUpdater({
      currentVersion: '0.5.0',
      baseUrl: () => 'https://everlook.example',
      arch: 'arm64',
      request: vi.fn<typeof fetch>().mockResolvedValue(new Response('missing', { status: 404 })),
      openExternal: vi.fn(),
      onState: vi.fn()
    })
    await updater.check()
    expect(updater.getState().error).toBe('The desktop release manifest could not be read (HTTP 404).')
  })
  it('says the site could not be reached when the request fails', async () => {
    const updater = new ManualUpdater({
      currentVersion: '0.5.0',
      baseUrl: () => 'https://everlook.example',
      arch: 'arm64',
      request: vi.fn<typeof fetch>().mockRejectedValue(new TypeError('fetch failed')),
      openExternal: vi.fn(),
      onState: vi.fn()
    })
    await updater.check()
    expect(updater.getState().error).toBe('Could not check for a Mac update. Try again when Everlook is reachable.')
  })
  it('reports current when the published version is older', async () => {
    const updater = new ManualUpdater({ currentVersion: '1.0.0', baseUrl: () => 'https://everlook.example', arch: 'arm64', request: vi.fn<typeof fetch>().mockResolvedValue(release()), openExternal: vi.fn(), onState: vi.fn() })
    await updater.check()
    expect(updater.getState()).toMatchObject({ status: 'current', availableVersion: null })
  })
})
