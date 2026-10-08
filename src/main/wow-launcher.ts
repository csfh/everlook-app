import { spawn, type SpawnOptions } from 'node:child_process'
import type { Dirent } from 'node:fs'
import { access, chmod, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { WowLauncherSettings, WowLauncherState, WowLaunchResult } from '../shared/types'
import { defaultWowLauncherSettings } from './settings'

export function bashSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

export function renderWowLauncherScript(settings: WowLauncherSettings): string {
  const gamescope: string[] = []
  if (settings.clearLdPreload) gamescope.push('env', '-u', 'LD_PRELOAD')
  gamescope.push('gamescope')
  gamescope.push('-w', '"$IN_W"', '-h', '"$IN_H"')
  gamescope.push('-W', '"$OUT_W"', '-H', '"$OUT_H"')
  gamescope.push('-S', bashSingleQuote(settings.scaler))
  if (settings.refreshRate !== null) gamescope.push('-r', String(settings.refreshRate))
  if (settings.fullscreen) gamescope.push('-f')
  if (settings.realtime) gamescope.push('--rt')
  if (settings.adaptiveSync) gamescope.push('--adaptive-sync')
  gamescope.push('--')
  if (settings.gameMode) gamescope.push('gamemoderun')
  gamescope.push('umu-run', '"$BATTLENET"')

  return `#!/usr/bin/env bash
set -euo pipefail

PREFIX=${bashSingleQuote(settings.prefix)}
BATTLENET=${bashSingleQuote(settings.battleNetLauncher)}
PROTON=${bashSingleQuote(settings.proton)}

[[ -d "$PROTON" ]] || { echo "Proton not found: $PROTON"; exit 1; }
[[ -f "$BATTLENET" ]] || { echo "Battle.net Launcher not found: $BATTLENET"; exit 1; }

export WINEPREFIX="$PREFIX"
export PROTONPATH="$PROTON"
export GAMEID=${bashSingleQuote(settings.gameId)}
export STORE=${bashSingleQuote(settings.store)}

IN_W=${settings.inputWidth}
IN_H=${settings.inputHeight}
OUT_W=${settings.outputWidth}
OUT_H=${settings.outputHeight}

${gamescope.join(' ')}
`
}

export const WOW_LAUNCHER_SCRIPT = renderWowLauncherScript(defaultWowLauncherSettings())

export type WowCommandLine = {
  pid: number
  command: string
}

/** The parts of a spawned launcher the launcher uses. A ChildProcess fits, and so does a test fake. */
export type LaunchedProcess = {
  readonly pid?: number | undefined
  unref(): void
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
}

export type SpawnWowLauncher = (
  command: string,
  args: readonly string[],
  options: SpawnOptions
) => LaunchedProcess

export type WowLauncherHooks = {
  homeDirectory: string
  platform: NodeJS.Platform
  spawn: SpawnWowLauncher
  listCommands: () => Promise<WowCommandLine[]>
  isAlive: (pid: number) => boolean
  killProcessGroup: (pid: number, signal: NodeJS.Signals) => void
  launcherSettings: () => WowLauncherSettings
  onChange?: (() => void) | undefined
}

export function idleWowLauncherState(): WowLauncherState {
  return {
    status: 'idle',
    scriptPath: null,
    error: null
  }
}

export function wowLauncherCandidates(homeDirectory: string): string[] {
  return [
    path.join(homeDirectory, 'Launchers', 'wow.sh'),
    path.join(homeDirectory, 'Launcher', 'wow.sh')
  ]
}

export function preferredWowLauncherPath(homeDirectory: string): string {
  return wowLauncherCandidates(homeDirectory)[0] ?? path.join(homeDirectory, 'Launchers', 'wow.sh')
}

export function commandBelongsToWowLauncher(command: string, scriptPaths: string[]): boolean {
  return scriptPaths.some((scriptPath) => isLauncherCommand(command, scriptPath))
}

function isLauncherCommand(command: string, scriptPath: string): boolean {
  if (scriptPath.length === 0) return false
  const at = indexOfArgument(command, scriptPath)
  if (at < 0) return false
  if (at === 0) return true
  const prefix = command.slice(0, at).trim()
  if (prefix === '') return true
  return prefix.split(/\s+/).every(isShellLauncherToken)
}

function indexOfArgument(command: string, argument: string): number {
  let from = 0
  while (from <= command.length - argument.length) {
    const at = command.indexOf(argument, from)
    if (at < 0) return -1
    const before = at === 0 || command[at - 1] === ' '
    const end = at + argument.length
    const after = end === command.length || command[end] === ' '
    if (before && after) return at
    from = at + 1
  }
  return -1
}

function isShellLauncherToken(token: string): boolean {
  const base = token.split(/[\\/]/).pop() ?? token
  return base === 'bash' || base === 'sh' || base === 'dash' || base === 'env'
}

export async function pathExists(candidate: string): Promise<boolean> {
  try {
    await access(candidate)
    return true
  } catch {
    return false
  }
}

export async function listLinuxCommandLines(
  procDirectory = '/proc'
): Promise<WowCommandLine[]> {
  let entries: Dirent[]
  try {
    entries = await readdir(procDirectory, { withFileTypes: true })
  } catch {
    return []
  }

  const commands: WowCommandLine[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[0-9]+$/.test(entry.name)) continue
    const pid = Number(entry.name)
    if (!Number.isInteger(pid)) continue
    try {
      const raw = await readFile(path.join(procDirectory, entry.name, 'cmdline'))
      if (raw.length === 0) continue
      const command = raw.toString('utf8').replaceAll('\0', ' ').trim()
      if (command.length === 0) continue
      commands.push({ pid, command })
    } catch {
      // The process exited while we were reading /proc.
    }
  }
  return commands
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export function killProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal)
  } catch {
    process.kill(pid, signal)
  }
}

export async function resolveWowLauncherPath(homeDirectory: string): Promise<string | null> {
  for (const candidate of wowLauncherCandidates(homeDirectory)) {
    if (await pathExists(candidate)) return candidate
  }
  return null
}

export async function ensureWowLauncher(
  homeDirectory: string,
  settings: WowLauncherSettings = defaultWowLauncherSettings(homeDirectory)
): Promise<{
  path: string
  created: boolean
}> {
  const existing = await resolveWowLauncherPath(homeDirectory)
  const scriptPath = existing ?? preferredWowLauncherPath(homeDirectory)
  const created = existing === null
  await mkdir(path.dirname(scriptPath), { recursive: true })
  await writeFile(scriptPath, renderWowLauncherScript(settings), 'utf8')
  await chmod(scriptPath, 0o755)
  return { path: scriptPath, created }
}

export class WowLauncher {
  private state: WowLauncherState = idleWowLauncherState()
  private childPid: number | null = null
  private busy = false

  constructor(private readonly hooks: WowLauncherHooks) {}

  static create(
    options: {
      homeDirectory?: string
      platform?: NodeJS.Platform
      launcherSettings?: () => WowLauncherSettings
      onChange?: () => void
    } = {}
  ): WowLauncher {
    const homeDirectory = options.homeDirectory ?? os.homedir()
    return new WowLauncher({
      homeDirectory,
      platform: options.platform ?? process.platform,
      spawn,
      listCommands: () => listLinuxCommandLines(),
      isAlive: isProcessAlive,
      killProcessGroup,
      launcherSettings:
        options.launcherSettings ?? (() => defaultWowLauncherSettings(homeDirectory)),
      onChange: options.onChange
    })
  }

  getState(): WowLauncherState {
    return { ...this.state }
  }

  async refresh(): Promise<WowLauncherState> {
    if (this.busy && (this.state.status === 'starting' || this.state.status === 'stopping')) {
      return this.getState()
    }

    if (this.childPid !== null && this.hooks.isAlive(this.childPid)) {
      this.setState({
        status: 'running',
        scriptPath: this.state.scriptPath ?? (await resolveWowLauncherPath(this.hooks.homeDirectory)),
        error: null
      })
      return this.getState()
    }

    this.childPid = null
    const scriptPath = await resolveWowLauncherPath(this.hooks.homeDirectory)
    const match = await this.findRunning(scriptPath)
    if (match !== null) {
      this.childPid = match.pid
      this.setState({
        status: 'running',
        scriptPath: match.scriptPath,
        error: null
      })
      return this.getState()
    }

    if (this.state.status !== 'error') {
      this.setState({
        status: 'idle',
        scriptPath,
        error: null
      })
    } else {
      this.setState({
        ...this.state,
        scriptPath,
        status: 'error'
      })
    }
    return this.getState()
  }

  async start(): Promise<WowLaunchResult> {
    if (this.hooks.platform !== 'linux') {
      throw new Error('Launch WoW is available on Linux with Launchers/wow.sh.')
    }
    if (this.busy) {
      await this.refresh()
      if (this.state.status === 'running' && this.state.scriptPath !== null) {
        return { status: 'already-running', scriptPath: this.state.scriptPath }
      }
      throw new Error('WoW is already starting or stopping.')
    }

    this.busy = true
    try {
      await this.refresh()
      if (this.state.status === 'running' && this.state.scriptPath !== null) {
        return { status: 'already-running', scriptPath: this.state.scriptPath }
      }

      this.setState({
        status: 'starting',
        scriptPath: this.state.scriptPath,
        error: null
      })

      const ensured = await ensureWowLauncher(
        this.hooks.homeDirectory,
        this.hooks.launcherSettings()
      )
      const child = this.hooks.spawn(ensured.path, [], {
        detached: true,
        stdio: 'ignore',
        cwd: path.dirname(ensured.path)
      })
      const pid = child.pid
      if (pid === undefined) {
        throw new Error('wow.sh started without a process id.')
      }

      this.childPid = pid
      child.unref()
      child.on('exit', (code, signal) => {
        if (this.childPid !== pid) return
        this.childPid = null
        if (this.state.status === 'stopping') {
          this.setState({
            status: 'idle',
            scriptPath: ensured.path,
            error: null
          })
          return
        }
        if (code === 0 || signal === 'SIGTERM' || signal === 'SIGINT' || signal === 'SIGHUP') {
          this.setState({
            status: 'idle',
            scriptPath: ensured.path,
            error: null
          })
          return
        }
        this.setState({
          status: 'error',
          scriptPath: ensured.path,
          error:
            code === null
              ? `wow.sh stopped (${signal ?? 'signal'}).`
              : `wow.sh exited with status ${code}. Check Proton Experimental and Battle.net under ~/Games/battlenet.`
        })
      })
      child.on('error', (error) => {
        if (this.childPid !== pid) return
        this.childPid = null
        this.setState({
          status: 'error',
          scriptPath: ensured.path,
          error: error instanceof Error ? error.message : 'wow.sh failed to start.'
        })
      })

      this.setState({
        status: 'running',
        scriptPath: ensured.path,
        error: null
      })
      return { status: 'started', scriptPath: ensured.path }
    } catch (error) {
      this.childPid = null
      const message = error instanceof Error ? error.message : 'wow.sh failed to start.'
      this.setState({
        status: 'error',
        scriptPath: this.state.scriptPath,
        error: message
      })
      throw error instanceof Error ? error : new Error(message)
    } finally {
      this.busy = false
    }
  }

  async stop(): Promise<void> {
    if (this.busy) {
      throw new Error('WoW is already starting or stopping.')
    }

    this.busy = true
    try {
      await this.refresh()
      const pid = this.childPid
      if (pid === null || this.state.status !== 'running') {
        this.setState({
          status: 'idle',
          scriptPath: this.state.scriptPath,
          error: null
        })
        return
      }

      this.setState({
        status: 'stopping',
        scriptPath: this.state.scriptPath,
        error: null
      })
      try {
        this.hooks.killProcessGroup(pid, 'SIGTERM')
      } catch (error) {
        if (this.hooks.isAlive(pid)) {
          throw error instanceof Error ? error : new Error('Could not stop wow.sh.')
        }
      }
      if (!this.hooks.isAlive(pid)) {
        this.childPid = null
        this.setState({
          status: 'idle',
          scriptPath: this.state.scriptPath,
          error: null
        })
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not stop wow.sh.'
      this.setState({
        status: 'error',
        scriptPath: this.state.scriptPath,
        error: message
      })
      throw error instanceof Error ? error : new Error(message)
    } finally {
      this.busy = false
    }
  }

  private async findRunning(
    knownScript: string | null
  ): Promise<{ pid: number; scriptPath: string } | null> {
    const candidates =
      knownScript === null
        ? wowLauncherCandidates(this.hooks.homeDirectory)
        : [knownScript, ...wowLauncherCandidates(this.hooks.homeDirectory)]
    const scriptPaths = [...new Set(candidates)]
    const commands = await this.hooks.listCommands()
    for (const entry of commands) {
      const scriptPath = scriptPaths.find((candidate) => commandBelongsToWowLauncher(entry.command, [candidate]))
      if (scriptPath !== undefined) {
        return { pid: entry.pid, scriptPath }
      }
    }
    return null
  }

  private setState(next: WowLauncherState): void {
    const changed =
      this.state.status !== next.status ||
      this.state.scriptPath !== next.scriptPath ||
      this.state.error !== next.error
    this.state = { ...next }
    if (changed) this.hooks.onChange?.()
  }
}
