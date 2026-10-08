import { execFileSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import process from 'node:process'
const targets = { 'linux-x64': ['linux', 'x64'], 'windows-x64': ['win32', 'x64'], 'macos-x64': ['darwin', 'x64'], 'macos-arm64': ['darwin', 'arm64'] }
const id = process.argv[2]
const target = targets[id]
const metadata = JSON.parse(await readFile('package.json', 'utf8'))
if (!target || target[0] !== process.platform || target[1] !== process.arch || metadata.version !== process.env.EVERLOOK_EXPECTED_VERSION) throw new Error('Native release target or prepared version does not match.')
const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
await writeFile(`dist/build-${id}.json`, JSON.stringify({ sourceSha, version: metadata.version, platform: process.platform, arch: process.arch }) + '\n')
