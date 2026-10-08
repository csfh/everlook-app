import process from 'node:process'
import console from 'node:console'
import { setTimeout, clearTimeout } from 'node:timers'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, readdir, readFile, access } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export async function packagedExecutable(directory, platform = process.platform) {
  if (platform === 'darwin') {
    const folders = await readdir(directory)
    const candidates = folders.filter((name) => name === 'mac' || name === 'mac-arm64')
    if (candidates.length !== 1) throw new Error('Expected one native Mac package.')
    const contents = path.join(directory, candidates[0], 'Everlook.app', 'Contents')
    const plist = await readFile(path.join(contents, 'Info.plist'), 'utf8')
    if (!plist.includes('<string>everlook</string>')) throw new Error('Packaged Mac protocol registration is missing.')
    return path.join(contents, 'MacOS', 'Everlook')
  }
  return path.join(directory, platform === 'win32' ? 'win-unpacked' : 'linux-unpacked', platform === 'win32' ? 'Everlook.exe' : 'everlook')
}

export async function runSmoke(executable, { environment = process.env, expectedVersion } = {}) {
  const userData = await mkdtemp(path.join(os.tmpdir(), 'everlook-smoke-'))
  try {
    await access(executable)
    await new Promise((resolve, reject) => {
      const child = spawn(executable, ['--smoke-test'], { env: { ...environment, EVERLOOK_SMOKE_USER_DATA: userData }, stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      const timeout = setTimeout(() => { child.kill(); reject(new Error('Packaged startup timed out.')) }, 45_000)
      child.stdout.on('data', (data) => { stdout += data })
      child.stderr.on('data', (data) => { stderr += data })
      child.on('error', (error) => { clearTimeout(timeout); reject(error) })
      child.on('close', (code) => {
        clearTimeout(timeout)
        if (code !== 0 || !stdout.includes('EVERLOOK_SMOKE_OK') || (expectedVersion && !stdout.includes(`EVERLOOK_SMOKE_VERSION=${expectedVersion}\n`))) reject(new Error(`Packaged startup failed (${code}). ${stderr.slice(-2000)}`))
        else resolve()
      })
    })
  } finally { await rm(userData, { recursive: true, force: true }) }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runSmoke(await packagedExecutable(path.resolve(process.argv[2] ?? 'dist')), { expectedVersion: process.env.EVERLOOK_EXPECTED_VERSION })
  console.log('Packaged startup and preload smoke passed.')
}
