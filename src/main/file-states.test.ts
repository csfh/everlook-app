import { describe, expect, it } from 'vitest'
import { projectFileStates, type FileRuntime } from './file-states'

const filePath = '/wow/_forever_/WTF/Account/Alice/SavedVariables/Everlook.lua'

describe('projectFileStates', () => {
  it('lets a live upload hide an older signature and history outcome', () => {
    const runtime = new Map<string, FileRuntime>([[filePath, {
      lastDetectedAt: '2026-10-05T00:00:00.000Z',
      status: 'uploading',
      error: null,
      response: null
    }]])

    expect(projectFileStates({
      selectedFiles: [filePath],
      uploads: { [filePath]: { hash: 'abc', uploadedAt: '2026-10-04T00:00:00.000Z' } },
      runtime,
      history: [
        { path: filePath, outcome: 'uploaded', signed: 'signed' },
        { path: filePath, outcome: 'error', signed: null }
      ],
      autoWatch: true
    })).toEqual([{
      path: filePath,
      account: 'Alice',
      lastDetectedAt: '2026-10-05T00:00:00.000Z',
      lastUploadedAt: '2026-10-04T00:00:00.000Z',
      lastUploadedHash: 'abc',
      status: 'uploading',
      error: null,
      response: null,
      signed: null
    }])
  })

  it('keeps a detected file on the history outcome but not its signature', () => {
    const runtime = new Map<string, FileRuntime>([[filePath, { lastDetectedAt: '2026-10-05T00:00:00.000Z' }]])

    expect(projectFileStates({
      selectedFiles: [filePath],
      uploads: {},
      runtime,
      history: [{ path: filePath, outcome: 'error', signed: 'signed' }],
      autoWatch: true
    })[0]).toMatchObject({
      status: 'error',
      signed: null,
      error: null,
      response: null,
      lastDetectedAt: '2026-10-05T00:00:00.000Z'
    })
  })

  it('uses the first history mark when nothing is in progress', () => {
    expect(projectFileStates({
      selectedFiles: [filePath],
      uploads: {},
      runtime: new Map(),
      history: [
        { path: '/other.lua', outcome: 'error', signed: null },
        { path: filePath, outcome: 'unchanged', signed: 'unsigned' },
        { path: filePath, outcome: 'uploaded', signed: 'signed' }
      ],
      autoWatch: false
    })[0]).toMatchObject({
      account: 'Alice',
      status: 'unchanged',
      signed: 'unsigned',
      lastDetectedAt: null,
      lastUploadedAt: null,
      lastUploadedHash: null,
      error: null,
      response: null
    })
  })

  it('watches a configured file only while automatic upload is on', () => {
    const input = {
      selectedFiles: ['/tmp/Everlook.lua'],
      uploads: {},
      runtime: new Map<string, FileRuntime>(),
      history: []
    }

    expect(projectFileStates({ ...input, autoWatch: true })[0]).toMatchObject({
      account: 'Unknown account',
      status: 'watching',
      signed: null
    })
    expect(projectFileStates({ ...input, autoWatch: false })[0]?.status).toBe('idle')
  })
})
