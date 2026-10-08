import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  additionsToWatch,
  canonicalSelectedWorldFile,
  stopWatching,
  watchFiles,
  worldFileKey
} from './watched-files'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function temporaryWorldFile(): Promise<{ root: string; target: string; link: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'everlook-watch-key-'))
  temporaryDirectories.push(root)
  const target = path.join(root, 'SavedVariables', 'Everlook.lua')
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, 'EverlookDB = {}')
  const link = path.join(root, 'linked.lua')
  await symlink(target, link, 'file')
  return { root, target, link }
}

function quoteForPowerShell(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

function firstAbsoluteWindowsPath(output: string): string | null {
  for (const line of output.split(/\r?\n/)) {
    const cleaned = line.trim().replaceAll('"', '')
    if (/^[A-Za-z]:\\/.test(cleaned)) return cleaned
  }
  return null
}

function windowsShortPath(filePath: string): string | null {
  if (process.platform !== 'win32') return null
  const safe = filePath.replaceAll('"', '')
  try {
    const powershell = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        [
          '$ErrorActionPreference = "Stop"',
          `$p = ${quoteForPowerShell(safe)}`,
          '$fso = New-Object -ComObject Scripting.FileSystemObject',
          'if (Test-Path -LiteralPath $p -PathType Container) { $fso.GetFolder($p).ShortPath } else { $fso.GetFile($p).ShortPath }'
        ].join('; ')
      ],
      { encoding: 'utf8' }
    )
    const fromPowershell = firstAbsoluteWindowsPath(powershell)
    if (fromPowershell) return fromPowershell
  } catch {
    // Fall through to cmd.exe GetShortPathName.
  }
  try {
    const fromCmd = firstAbsoluteWindowsPath(
      spawnSync('cmd.exe', ['/d', '/c', `for %I in ("${safe}") do @echo %~sI`], {
        encoding: 'utf8',
        windowsVerbatimArguments: true
      }).stdout
    )
    return fromCmd
  } catch {
    return null
  }
}

describe('watched world files', () => {
  const saved = '/wow/_forever_/WTF/Account/1/SavedVariables/Everlook.lua'
  const other = '/wow/_forever_/WTF/Account/2/SavedVariables/Everlook.lua'

  it('does not rediscover a file the user stopped watching', () => {
    const stopped = stopWatching([saved, other], [], saved)
    expect(stopped.selectedFiles).toEqual([other])
    expect(additionsToWatch([saved, other], stopped.selectedFiles, stopped.ignoredFiles)).toEqual([])
    expect(additionsToWatch([saved, other, '/wow/new/Everlook.lua'], stopped.selectedFiles, stopped.ignoredFiles)).toEqual([
      '/wow/new/Everlook.lua'
    ])
  })

  it('watches a stopped file again when the user chooses it', () => {
    const stopped = stopWatching([saved], [], saved)
    const chosen = watchFiles(stopped.selectedFiles, stopped.ignoredFiles, [saved])
    expect(chosen.selectedFiles).toEqual([saved])
    expect(chosen.ignoredFiles).toEqual([])
    expect(additionsToWatch([saved], chosen.selectedFiles, chosen.ignoredFiles)).toEqual([])
  })

  it('matches the selected spelling of a world file', () => {
    expect(canonicalSelectedWorldFile(saved, [saved, other])).toBe(saved)
    expect(canonicalSelectedWorldFile('/missing/Everlook.lua', [saved])).toBeNull()
    if (process.platform === 'win32') {
      expect(worldFileKey('C:\\Wow\\Everlook.lua')).toBe(worldFileKey('c:\\wow\\Everlook.lua'))
    } else {
      expect(worldFileKey('/Wow/Everlook.lua')).not.toBe(worldFileKey('/wow/Everlook.lua'))
    }
  })

  it('treats a symlinked world file and its target as one file', async () => {
    const { target, link } = await temporaryWorldFile()
    const resolved = await realpath(target)

    expect(worldFileKey(link)).toBe(worldFileKey(target))
    expect(worldFileKey(link)).toBe(worldFileKey(resolved))
    expect(canonicalSelectedWorldFile(target, [link])).toBe(link)
    expect(canonicalSelectedWorldFile(resolved, [link])).toBe(link)
    expect(additionsToWatch([target, resolved], [link], [])).toEqual([])
  })

  it.skipIf(process.platform !== 'win32')('treats a Windows 8.3 path and its long name as one file', async () => {
    const { target, link } = await temporaryWorldFile()
    const resolved = await realpath(target)
    const short = windowsShortPath(target) ?? windowsShortPath(resolved)
    expect(short).toMatch(/^[A-Za-z]:\\/)
    expect(short).not.toContain('"')
    if (short === null) return
    expect(worldFileKey(short)).toBe(worldFileKey(target))
    expect(worldFileKey(short)).toBe(worldFileKey(resolved))
    expect(worldFileKey(short)).toBe(worldFileKey(link))
    expect(worldFileKey(`"${short}"`)).toBe(worldFileKey(target))
    expect(canonicalSelectedWorldFile(short, [link])).toBe(link)
    expect(additionsToWatch([short], [link], [])).toEqual([])
  })
})
