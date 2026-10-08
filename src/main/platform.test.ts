import { describe, expect, it } from 'vitest'
import { getPlatformCapabilities } from './platform'

describe('platform capabilities', () => {
  it('keeps managed gamescope on Linux and supports updates only for packaged AppImages', () => {
    expect(getPlatformCapabilities({ platform: 'linux', arch: 'x64', packaged: true, appImage: '/opt/Everlook.AppImage' })).toEqual({
      platform: 'linux', arch: 'x64', managedWowLauncher: true, nativeBattleNet: false,
      loginStartup: true, automaticUpdates: true
    })
    expect(getPlatformCapabilities({ platform: 'linux', packaged: true, appImage: '' }).automaticUpdates).toBe(false)
  })

  it.each(['win32', 'darwin'] as const)('uses native Battle.net on %s and supports Windows packaged updates', (platform) => {
    expect(getPlatformCapabilities({ platform, arch: 'arm64', packaged: true })).toMatchObject({
      platform, arch: 'arm64', managedWowLauncher: false, nativeBattleNet: true,
      loginStartup: true, automaticUpdates: platform === 'win32'
    })
  })

  it.each(['linux', 'win32', 'darwin', 'freebsd'] as const)('disables login startup and updates in development on %s', (platform) => {
    expect(getPlatformCapabilities({ platform, packaged: false, appImage: '/opt/app' })).toMatchObject({
      loginStartup: false, automaticUpdates: false
    })
  })

  it('does not claim support on other platforms', () => {
    expect(getPlatformCapabilities({ platform: 'freebsd', packaged: true })).toMatchObject({
      managedWowLauncher: false, nativeBattleNet: false, loginStartup: false, automaticUpdates: false
    })
  })
})
