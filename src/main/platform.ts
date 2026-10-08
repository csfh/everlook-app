export type PlatformCapabilities = {
  platform: NodeJS.Platform
  arch: string
  managedWowLauncher: boolean
  nativeBattleNet: boolean
  loginStartup: boolean
  automaticUpdates: boolean
}

export function getPlatformCapabilities(input: {
  platform?: NodeJS.Platform
  arch?: string
  packaged?: boolean
  appImage?: string
} = {}): PlatformCapabilities {
  const platform = input.platform ?? process.platform
  const packaged = input.packaged ?? false
  const linux = platform === 'linux'
  const nativeBattleNet = platform === 'win32' || platform === 'darwin'
  return {
    platform,
    arch: input.arch ?? process.arch,
    managedWowLauncher: linux,
    nativeBattleNet,
    loginStartup: packaged && (linux || nativeBattleNet),
    automaticUpdates: packaged && (platform === 'win32' || (linux && Boolean((input.appImage ?? process.env.APPIMAGE)?.trim())))
  }
}
