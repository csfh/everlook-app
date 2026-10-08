import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SpawnOptions } from 'node:child_process'
import {
  commandBelongsToWowLauncher,
  ensureWowLauncher,
  listLinuxCommandLines,
  preferredWowLauncherPath,
  resolveWowLauncherPath,
  renderWowLauncherScript,
  WowLauncher,
  wowLauncherCandidates,
  type SpawnWowLauncher,
  type WowCommandLine,
  type WowLauncherHooks
} from './wow-launcher'
import { defaultWowLauncherSettings } from './settings'

const temporaryDirectories: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })))
})

async function makeHome(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'everlook-wow-'))
  temporaryDirectories.push(directory)
  return directory
}

class FakeChild extends EventEmitter {
  pid: number
  unref = vi.fn()

  constructor(pid: number) {
    super()
    this.pid = pid
  }
}

function hooks(overrides: Partial<WowLauncherHooks> & { homeDirectory: string }): WowLauncherHooks {
  return {
    platform: 'linux',
    spawn: vi.fn<SpawnWowLauncher>(),
    listCommands: async () => [],
    isAlive: () => false,
    killProcessGroup: vi.fn(),
    launcherSettings: () => defaultWowLauncherSettings(overrides.homeDirectory),
    ...overrides
  }
}

describe('wow.sh template', () => {
  it('renders gamescope + umu-run from launcher settings', () => {
    const home = path.join(os.tmpdir(), 'everlook-wow-home')
    const settings = defaultWowLauncherSettings(home)
    const script = renderWowLauncherScript(settings)
    expect(script.startsWith('#!/usr/bin/env bash\n')).toBe(true)
    expect(script).toContain(`PREFIX='${path.join(home, 'Games', 'battlenet')}'`)
    expect(script).toContain('Battle.net Launcher.exe')
    expect(script).toContain('GE-Proton11-7-x86_64')
    expect(script).toContain("GAMEID='umu-default'")
    expect(script).toContain("STORE='battlenet'")
    expect(script).toContain('gamemoderun umu-run "$BATTLENET"')
    expect(script).toContain('env -u LD_PRELOAD gamescope')
    expect(script).toContain('--rt')
    expect(script).toContain('IN_W=3008')
    expect(script).toContain('OUT_W=6016')
    expect(script).not.toContain('steamapps/compatdata')
  })

  it('omits optional gamescope flags when they are off', () => {
    const script = renderWowLauncherScript({
      ...defaultWowLauncherSettings(path.join(os.tmpdir(), 'everlook-wow-home')),
      fullscreen: false,
      adaptiveSync: false,
      realtime: false,
      clearLdPreload: false,
      gameMode: false,
      refreshRate: 60
    })
    const gamescopeLine = script.trim().split('\n').at(-1) ?? ''
    expect(gamescopeLine.startsWith('gamescope ')).toBe(true)
    expect(gamescopeLine).toContain('-r 60')
    expect(gamescopeLine).not.toContain('LD_PRELOAD')
    expect(gamescopeLine).not.toContain('--rt')
    expect(gamescopeLine).not.toContain('--adaptive-sync')
    expect(gamescopeLine.split(' ')).not.toContain('-f')
    expect(gamescopeLine).not.toContain('gamemoderun')
    expect(gamescopeLine).toContain('umu-run "$BATTLENET"')
  })
})

describe('wow launcher paths', () => {
  it('prefers Launchers/wow.sh over Launcher/wow.sh', () => {
    const home = path.join(os.tmpdir(), 'everlook-wow-home')
    expect(wowLauncherCandidates(home)).toEqual([
      path.join(home, 'Launchers', 'wow.sh'),
      path.join(home, 'Launcher', 'wow.sh')
    ])
    expect(preferredWowLauncherPath(home)).toBe(path.join(home, 'Launchers', 'wow.sh'))
  })

  it('matches only the wow.sh command line', () => {
    const script = '/home/user/Launchers/wow.sh'
    expect(commandBelongsToWowLauncher(`bash ${script}`, [script])).toBe(true)
    expect(commandBelongsToWowLauncher(`/usr/bin/env bash ${script}`, [script])).toBe(true)
    expect(commandBelongsToWowLauncher(`${script} --background`, [script])).toBe(true)
    expect(commandBelongsToWowLauncher('bash /home/user/My Launchers/wow.sh', ['/home/user/My Launchers/wow.sh'])).toBe(true)
    expect(commandBelongsToWowLauncher(`vim ${script}`, [script])).toBe(false)
    expect(commandBelongsToWowLauncher(`bash ${script}.bak`, [script])).toBe(false)
    expect(
      commandBelongsToWowLauncher('umu-run /home/user/Games/battlenet/drive_c/Battle.net', [script])
    ).toBe(false)
  })
})

describe('ensureWowLauncher', () => {
  it('creates Launchers/wow.sh when neither script exists', async () => {
    const home = await makeHome()

    const result = await ensureWowLauncher(home)

    expect(result).toEqual({ path: path.join(home, 'Launchers', 'wow.sh'), created: true })
    expect(await readFile(result.path, 'utf8')).toBe(
      renderWowLauncherScript(defaultWowLauncherSettings(home))
    )
    if (process.platform !== 'win32') expect((await stat(result.path)).mode & 0o111).not.toBe(0)
  })

  it('rewrites an existing Launchers/wow.sh from launcher settings', async () => {
    const home = await makeHome()
    const scriptPath = path.join(home, 'Launchers', 'wow.sh')
    await mkdir(path.dirname(scriptPath), { recursive: true })
    await writeFile(scriptPath, '#!/bin/sh\necho custom\n', { mode: 0o755 })
    const settings = {
      ...defaultWowLauncherSettings(home),
      inputWidth: 1920,
      inputHeight: 1080
    }

    const result = await ensureWowLauncher(home, settings)

    expect(result).toEqual({ path: scriptPath, created: false })
    expect(await readFile(scriptPath, 'utf8')).toContain('IN_W=1920')
    expect(await readFile(scriptPath, 'utf8')).toContain('IN_H=1080')
  })

  it('uses an existing Launcher/wow.sh when Launchers is absent', async () => {
    const home = await makeHome()
    const scriptPath = path.join(home, 'Launcher', 'wow.sh')
    await mkdir(path.dirname(scriptPath), { recursive: true })
    await writeFile(scriptPath, '#!/bin/sh\necho singular\n', { mode: 0o755 })

    await expect(resolveWowLauncherPath(home)).resolves.toBe(scriptPath)
    await expect(ensureWowLauncher(home)).resolves.toEqual({ path: scriptPath, created: false })
    expect(await readFile(scriptPath, 'utf8')).toBe(
      renderWowLauncherScript(defaultWowLauncherSettings(home))
    )
  })

  it('makes the rewritten script executable', async () => {
    const home = await makeHome()
    const scriptPath = path.join(home, 'Launchers', 'wow.sh')
    await mkdir(path.dirname(scriptPath), { recursive: true })
    await writeFile(scriptPath, '#!/bin/sh\necho wow\n', { mode: 0o644 })

    await ensureWowLauncher(home)

    expect(await readFile(scriptPath, 'utf8')).toBe(
      renderWowLauncherScript(defaultWowLauncherSettings(home))
    )
    if (process.platform !== 'win32') expect((await stat(scriptPath)).mode & 0o111).not.toBe(0)
  })
})

describe('listLinuxCommandLines', () => {
  it('reads null-separated /proc cmdline files', async () => {
    const proc = await makeHome()
    await mkdir(path.join(proc, '12'))
    await mkdir(path.join(proc, 'not-a-pid'))
    await writeFile(path.join(proc, '12', 'cmdline'), 'bash\0/tmp/Launchers/wow.sh\0')
    await writeFile(path.join(proc, 'not-a-pid', 'cmdline'), 'ignore')

    await expect(listLinuxCommandLines(proc)).resolves.toEqual([
      { pid: 12, command: 'bash /tmp/Launchers/wow.sh' }
    ])
  })
})

describe('WowLauncher', () => {
  it('starts the existing wow.sh without invoking Wine', async () => {
    const home = await makeHome()
    const scriptPath = path.join(home, 'Launchers', 'wow.sh')
    await mkdir(path.dirname(scriptPath), { recursive: true })
    await writeFile(scriptPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    const child = new FakeChild(4242)
    const spawn = vi.fn<SpawnWowLauncher>(() => child)
    const launcher = new WowLauncher(
      hooks({
        homeDirectory: home,
        spawn,
        isAlive: (pid) => pid === 4242
      })
    )

    await expect(launcher.start()).resolves.toEqual({ status: 'started', scriptPath })

    expect(spawn).toHaveBeenCalledTimes(1)
    const [command, args, options] = spawn.mock.calls[0] as [string, string[], SpawnOptions]
    expect(command).toBe(scriptPath)
    expect(args).toEqual([])
    expect(options.detached).toBe(true)
    expect(options.stdio).toBe('ignore')
    expect(options.cwd).toBe(path.dirname(scriptPath))
    expect(child.unref).toHaveBeenCalledOnce()
    expect(launcher.getState()).toEqual({
      status: 'running',
      scriptPath,
      error: null
    })
  })

  it('creates wow.sh then starts it when the script is missing', async () => {
    const home = await makeHome()
    const scriptPath = path.join(home, 'Launchers', 'wow.sh')
    const child = new FakeChild(7)
    const spawn = vi.fn<SpawnWowLauncher>(() => child)
    const launcher = new WowLauncher(hooks({ homeDirectory: home, spawn, isAlive: () => true }))

    await expect(launcher.start()).resolves.toEqual({ status: 'started', scriptPath })
    expect(await readFile(scriptPath, 'utf8')).toBe(
      renderWowLauncherScript(defaultWowLauncherSettings(home))
    )
    expect(spawn).toHaveBeenCalledWith(scriptPath, [], expect.objectContaining({ detached: true }))
  })

  it('does not spawn a second session when wow.sh is already running', async () => {
    const home = await makeHome()
    const scriptPath = path.join(home, 'Launchers', 'wow.sh')
    await mkdir(path.dirname(scriptPath), { recursive: true })
    await writeFile(scriptPath, renderWowLauncherScript(defaultWowLauncherSettings(home)), {
      mode: 0o755
    })
    const spawn = vi.fn<SpawnWowLauncher>()
    const running: WowCommandLine[] = [{ pid: 99, command: `bash ${scriptPath}` }]
    const launcher = new WowLauncher(
      hooks({
        homeDirectory: home,
        spawn,
        listCommands: async () => running,
        isAlive: (pid) => pid === 99
      })
    )

    await expect(launcher.start()).resolves.toEqual({
      status: 'already-running',
      scriptPath
    })
    expect(spawn).not.toHaveBeenCalled()
    expect(launcher.getState().status).toBe('running')
  })

  it('does not treat an editor or a backup script as a running launcher', async () => {
    const home = await makeHome()
    const scriptPath = path.join(home, 'Launchers', 'wow.sh')
    await mkdir(path.dirname(scriptPath), { recursive: true })
    await writeFile(scriptPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    const child = new FakeChild(4242)
    const spawn = vi.fn<SpawnWowLauncher>(() => child)
    const killProcessGroup = vi.fn()
    const launcher = new WowLauncher(
      hooks({
        homeDirectory: home,
        spawn,
        listCommands: async () => [
          { pid: 5, command: `vim ${scriptPath}` },
          { pid: 6, command: `bash ${scriptPath}.bak` },
          { pid: 9, command: `bash ${scriptPath}` }
        ],
        isAlive: (pid) => pid === 9 || pid === 4242,
        killProcessGroup
      })
    )

    await expect(launcher.start()).resolves.toEqual({ status: 'already-running', scriptPath })
    expect(spawn).not.toHaveBeenCalled()
    await launcher.stop()
    expect(killProcessGroup).toHaveBeenCalledTimes(1)
    expect(killProcessGroup).toHaveBeenCalledWith(9, 'SIGTERM')
  })

  it('does not spawn again when the tracked child is still alive', async () => {
    const home = await makeHome()
    const scriptPath = path.join(home, 'Launchers', 'wow.sh')
    const child = new FakeChild(4242)
    const spawn = vi.fn<SpawnWowLauncher>(() => child)
    const launcher = new WowLauncher(
      hooks({
        homeDirectory: home,
        spawn,
        isAlive: (pid) => pid === 4242
      })
    )

    await launcher.start()
    await expect(launcher.start()).resolves.toEqual({
      status: 'already-running',
      scriptPath
    })
    expect(spawn).toHaveBeenCalledTimes(1)
  })

  it('stops by signaling the wow.sh process group', async () => {
    const home = await makeHome()
    const child = new FakeChild(4242)
    const killProcessGroup = vi.fn()
    const launcher = new WowLauncher(
      hooks({
        homeDirectory: home,
        spawn: () => child,
        isAlive: (pid) => pid === 4242,
        killProcessGroup
      })
    )

    await launcher.start()
    killProcessGroup.mockImplementation(() => {
      child.emit('exit', 0, 'SIGTERM')
    })
    await launcher.stop()

    expect(killProcessGroup).toHaveBeenCalledWith(4242, 'SIGTERM')
    expect(launcher.getState().status).toBe('idle')
  })

  it('refuses to start on non-Linux hosts', async () => {
    const home = await makeHome()
    const spawn = vi.fn<SpawnWowLauncher>()
    const launcher = new WowLauncher(hooks({ homeDirectory: home, platform: 'darwin', spawn }))

    await expect(launcher.start()).rejects.toThrow('Linux')
    expect(spawn).not.toHaveBeenCalled()
    expect(await resolveWowLauncherPath(home)).toBeNull()
  })

  it('records a failed wow.sh exit without treating a clean close as an error', async () => {
    const home = await makeHome()
    const child = new FakeChild(8)
    const launcher = new WowLauncher(
      hooks({
        homeDirectory: home,
        spawn: () => child,
        isAlive: () => true
      })
    )

    await launcher.start()
    child.emit('exit', 1, null)
    expect(launcher.getState().status).toBe('error')
    expect(launcher.getState().error).toContain('exited with status 1')

    const clean = new FakeChild(9)
    const cleanLauncher = new WowLauncher(
      hooks({
        homeDirectory: home,
        spawn: () => clean,
        isAlive: () => true
      })
    )
    await cleanLauncher.start()
    clean.emit('exit', 0, null)
    expect(cleanLauncher.getState().status).toBe('idle')
    expect(cleanLauncher.getState().error).toBeNull()
  })
})
