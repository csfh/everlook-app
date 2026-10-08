import { URL } from 'node:url'
import process from 'node:process'
import console from 'node:console'
import { setTimeout, clearTimeout } from 'node:timers'
// Runs only on a disposable Windows CI runner: install a fixture, update it, then uninstall.
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { createReadStream } from 'node:fs'
import { mkdtemp, readFile, rm, access, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { runSmoke } from './package-smoke.mjs'

function execute(executable, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { shell: false, ...options })
    let output = ''
    child.stdout?.on('data', (data) => { output += data })
    child.stderr?.on('data', (data) => { output += data })
    const timeout = setTimeout(() => { child.kill(); reject(new Error('Windows update smoke timed out.')) }, 240_000)
    child.on('error', (error) => { clearTimeout(timeout); reject(error) })
    child.on('close', (code) => { clearTimeout(timeout); if (code === 0) resolve(output); else reject(new Error(`Windows smoke command failed (${code}). ${output.slice(-2000)}`)) })
  })
}
if (process.platform !== 'win32' || process.env.CI !== 'true') throw new Error('This fixture runs only on a disposable Windows CI runner.')
const root = await mkdtemp(path.join(os.tmpdir(), 'everlook-update-'))
const installed = path.join(root, 'installed')
const fixtures = path.join(root, 'old')
const userData = path.join(root, 'user-data')
const releaseDirectory = path.resolve('dist')
const version = JSON.parse(await readFile('package.json', 'utf8')).version
const allowed = new Set(['latest.yml', `Everlook-${version}-windows-x64.exe`, `Everlook-${version}-windows-x64.exe.blockmap`])
const server = createServer(async (request, response) => {
  const name = new URL(request.url ?? '/', 'http://127.0.0.1').pathname.slice(1)
  if (!allowed.has(name)) { response.writeHead(404).end(); return }
  try {
    response.setHeader('Content-Length', (await stat(path.join(releaseDirectory, name))).size)
    const stream = createReadStream(path.join(releaseDirectory, name))
    stream.on('error', () => response.destroy())
    stream.pipe(response)
  } catch { response.writeHead(404).end() }
})
try {
  for (const name of allowed) await access(path.join(releaseDirectory, name))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  // The tracked release version stays untouched. extraMetadata creates only an older test installer.
  const builder = path.resolve('node_modules/electron-builder/cli.js')
  await execute(process.execPath, [builder, '--win', 'nsis', '--x64', '--publish', 'never', '--config.extraMetadata.version=0.0.0', '--config.nsis.runAfterFinish=false', `--config.directories.output=${fixtures}`])
  await execute(path.join(fixtures, 'Everlook-0.0.0-windows-x64.exe'), ['/S', `/D=${installed}`])
  const executable = path.join(installed, 'Everlook.exe')
  await access(executable)
  const output = await execute(executable, ['--update-smoke-test'], { env: { ...process.env, EVERLOOK_SMOKE_USER_DATA: userData, EVERLOOK_SMOKE_FEED: `http://127.0.0.1:${port}` } })
  if (!output.includes('EVERLOOK_UPDATE_SMOKE_OK')) throw new Error('The old app did not download and install an update.')
  const deadline = Date.now() + 120_000
  let updated = false
  while (Date.now() < deadline && !updated) {
    try { await runSmoke(executable, { expectedVersion: version, environment: { ...process.env, EVERLOOK_SMOKE_REGISTER_PROTOCOL: '1' } }); updated = true }
    catch { await new Promise((resolve) => setTimeout(resolve, 1000)) }
  }
  if (!updated) throw new Error('Installed app did not become the prepared release version.')
  const protocol = await execute('reg.exe', ['query', 'HKCU\\Software\\Classes\\everlook\\shell\\open\\command', '/ve'])
  if (!protocol.toLowerCase().includes(`"${executable.toLowerCase()}"`) || !protocol.includes('%1')) throw new Error('Windows everlook:// registration is missing.')
  console.log('Windows older-to-newer installed update and protocol smoke passed.')
} finally {
  await new Promise((resolve) => server.close(resolve))
  const uninstaller = path.join(installed, 'Uninstall Everlook.exe')
  try { await execute(uninstaller, ['/S']) } catch { /* A failed installation may have no uninstaller. */ }
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 })
}
