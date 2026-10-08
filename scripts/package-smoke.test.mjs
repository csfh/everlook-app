import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { packagedExecutable } from './package-smoke.mjs'
test('uses native executables without shell interpolation', async () => {
  assert.equal(await packagedExecutable('/release with spaces', 'win32'), path.join('/release with spaces', 'win-unpacked', 'Everlook.exe'))
  assert.equal(await packagedExecutable('/release with spaces', 'linux'), path.join('/release with spaces', 'linux-unpacked', 'everlook'))
})
