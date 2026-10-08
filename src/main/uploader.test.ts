import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { describeUpload, readStableWorldFile, UNSTABLE_WORLD_FILE_CODE, UploadCoordinator, UploadError, uploadOutcome } from './uploader'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true }))
  )
})

describe('stable world file reads', () => {
  it('waits through a detected write before returning contents', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'everlook-stable-'))
    temporaryDirectories.push(root)
    const worldFile = path.join(root, 'Everlook.lua')
    await writeFile(worldFile, 'first')
    let waits = 0

    const contents = await readStableWorldFile(worldFile, async () => {
      waits += 1
      if (waits === 1) await writeFile(worldFile, 'settled contents')
    })

    expect(contents.toString()).toBe('settled contents')
    expect(waits).toBe(2)
  })

  it('fails with a retryable code when the file never settles', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'everlook-stable-'))
    temporaryDirectories.push(root)
    const worldFile = path.join(root, 'Everlook.lua')
    await writeFile(worldFile, 'first')
    let writes = 0

    await expect(readStableWorldFile(worldFile, async () => {
      writes += 1
      await writeFile(worldFile, `still changing ${'x'.repeat(writes)}`)
    })).rejects.toMatchObject({
      code: UNSTABLE_WORLD_FILE_CODE,
      message: 'Everlook.lua is still changing. Everlook will try again after it settles.'
    })
    expect(writes).toBe(4)
  })
})

describe('UploadCoordinator', () => {
  it('hands Retry-After to persistent recovery instead of making immediate retries', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response('busy', { status: 429, headers: { 'Retry-After': '60' } }))
    const uploader = new UploadCoordinator({ previousHash: () => null, token: async () => 'a'.repeat(64), baseUrl: () => 'https://everlook.example', saved: vi.fn(), readStable: async () => Buffer.from('world'), request, sleep: vi.fn() })
    await expect(uploader.upload('/tmp/Everlook.lua')).rejects.toMatchObject({ httpStatus: 429, retryAfterMs: 60_000 })
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('carries security_required beside the HTTP status', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      code: 'security_required',
      message: 'Add a passkey and an authenticator app to upload.',
      setup_url: 'https://everlook.example/account/security'
    }), { status: 403 }))
    const uploader = new UploadCoordinator({ previousHash: () => null, token: async () => 'a'.repeat(64), baseUrl: () => 'https://everlook.example', saved: vi.fn(), readStable: async () => Buffer.from('world'), request, sleep: vi.fn() })
    await expect(uploader.upload('/tmp/Everlook.lua')).rejects.toMatchObject({
      httpStatus: 403,
      code: 'security_required',
      setupUrl: 'https://everlook.example/account/security'
    })
  })

  it('carries contributions_revoked beside the HTTP status', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      code: 'contributions_revoked',
      message: 'Contributions from this account were revoked.'
    }), { status: 403 }))
    const uploader = new UploadCoordinator({ previousHash: () => null, token: async () => 'a'.repeat(64), baseUrl: () => 'https://everlook.example', saved: vi.fn(), readStable: async () => Buffer.from('world'), request, sleep: vi.fn() })
    await expect(uploader.upload('/tmp/Everlook.lua')).rejects.toMatchObject({
      httpStatus: 403,
      code: 'contributions_revoked',
      setupUrl: null
    })
  })

  it('leaves a plain 403 without a body code', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response('denied', { status: 403 }))
    const uploader = new UploadCoordinator({ previousHash: () => null, token: async () => 'a'.repeat(64), baseUrl: () => 'https://everlook.example', saved: vi.fn(), readStable: async () => Buffer.from('world'), request, sleep: vi.fn() })
    await expect(uploader.upload('/tmp/Everlook.lua')).rejects.toMatchObject({ httpStatus: 403, code: null, setupUrl: null })
  })
  it('aborts an in-flight request and does not acknowledge the file', async () => {
    const controller = new AbortController()
    const saved = vi.fn()
    const request = vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
      controller.abort()
      init?.signal?.throwIfAborted()
      return new Response(null, { status: 202 })
    })
    const uploader = new UploadCoordinator({ previousHash: () => null, token: async () => 'a'.repeat(64), baseUrl: () => 'https://everlook.example', saved, readStable: async () => Buffer.from('world'), request })
    await expect(uploader.upload('/tmp/Everlook.lua', { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(saved).not.toHaveBeenCalled()
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('hashes before upload and skips an unchanged world file', async () => {
    const contents = Buffer.from('worldFile')
    const hash = createHash('sha256').update(contents).digest('hex')
    const request = vi.fn<typeof fetch>()
    const uploader = new UploadCoordinator({
      previousHash: () => hash,
      token: async () => 'token',
      baseUrl: () => 'https://everlook.example',
      saved: vi.fn(),
      readStable: async () => contents,
      request
    })

    const result = await uploader.upload('/tmp/Everlook.lua')

    expect(result).toEqual({
      hash,
      uploadedAt: null,
      unchanged: true,
      responses: []
    })
    expect(describeUpload(result)).toBe('No request sent. This file matches the last upload.')
    expect(request).not.toHaveBeenCalled()
  })

  it('asks Everlook again when an upload is forced', async () => {
    const contents = Buffer.from('worldFile')
    const hash = createHash('sha256').update(contents).digest('hex')
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          message: 'This world file was already uploaded.',
          upload: { id: 18, duplicate: true, status: 'completed' }
        }),
        { status: 202 }
      )
    )
    const uploader = new UploadCoordinator({
      previousHash: () => hash,
      token: async () => 'token',
      baseUrl: () => 'https://everlook.example',
      saved: vi.fn(),
      readStable: async () => contents,
      request,
      sleep: async () => undefined
    })

    const result = await uploader.upload('/tmp/Everlook.lua', { force: true })

    expect(uploadOutcome(result)).toBe('unchanged')
    expect(describeUpload(result)).toBe('Check 202\nThis world file was already uploaded.\nUpload 18 · completed · duplicate')
    expect(JSON.stringify(result.responses)).not.toContain('https://')
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('puts the world file to a signed url then completes ingest', async () => {
    const contents = Buffer.from('new worldFile')
    const saved = vi.fn()
    const key = '2026/09/16/01ARZ3NDEKTSV4RRFFQ69G5FAV.lua'
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            message: 'World file accepted for upload.',
            upload: {
              id: 18,
              status: 'pending',
              duplicate: false,
              key,
              url: 'https://r2.example/2026/09/16/file.lua?X-Amz-Signature=secret',
              headers: { 'Content-Type': 'text/x-lua', Host: 'r2.example' },
              method: 'PUT'
            }
          }),
          { status: 202 }
        )
      )
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ upload: { duplicate: false } }), { status: 202 }))
    const uploader = new UploadCoordinator({
      previousHash: () => null,
      token: async () => 'a'.repeat(64),
      baseUrl: () => 'https://everlook.example',
      saved,
      readStable: async () => contents,
      request,
      sleep: async () => undefined
    })

    const result = await uploader.upload('/tmp/Everlook.lua')
    expect(uploadOutcome(result)).toBe('uploaded')
    expect(describeUpload(result)).toContain('World file accepted for upload.')
    expect(describeUpload(result)).toContain('Storage 200')
    expect(describeUpload(result)).not.toContain('X-Amz-Signature')
    expect(request).toHaveBeenCalledTimes(3)

    const [intentUrl, intentInit] = request.mock.calls[0] ?? []
    expect(intentUrl).toBe('https://everlook.example/api/desktop/addon/uploads')
    expect(intentInit?.method).toBe('POST')
    expect(intentInit?.headers).toMatchObject({
      Authorization: `Bearer ${'a'.repeat(64)}`,
      'Content-Type': 'application/json'
    })
    expect(JSON.parse(String(intentInit?.body))).toEqual({
      sha256: result.hash,
      byte_size: contents.byteLength,
      original_name: 'Everlook.lua'
    })

    const [putUrl, putInit] = request.mock.calls[1] ?? []
    expect(putUrl).toBe('https://r2.example/2026/09/16/file.lua?X-Amz-Signature=secret')
    expect(putInit?.method).toBe('PUT')
    expect(putInit?.body).toBe(contents)
    expect(putInit?.headers).toEqual({ 'Content-Type': 'text/x-lua' })

    const [completeUrl, completeInit] = request.mock.calls[2] ?? []
    expect(completeUrl).toBe('https://everlook.example/api/desktop/addon/uploads/complete')
    expect(JSON.parse(String(completeInit?.body))).toEqual({
      key,
      sha256: result.hash,
      byte_size: contents.byteLength
    })
    expect(saved).toHaveBeenCalledWith('/tmp/Everlook.lua', result.hash, result.uploadedAt)
  })

  it('retries transient responses and records a successful hash', async () => {
    const contents = Buffer.from('new worldFile')
    const saved = vi.fn()
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('busy', { status: 503 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            upload: {
              duplicate: false,
              key: '2026/09/16/01ARZ3NDEKTSV4RRFFQ69G5FAV.lua',
              url: 'https://r2.example/2026/09/16/file.lua',
              headers: { 'Content-Type': 'text/x-lua' },
              method: 'PUT'
            }
          }),
          { status: 202 }
        )
      )
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ upload: { duplicate: false } }), { status: 202 }))
    const uploader = new UploadCoordinator({
      previousHash: () => null,
      token: async () => 'a'.repeat(64),
      baseUrl: () => 'https://everlook.example',
      saved,
      readStable: async () => contents,
      request,
      sleep: async () => undefined
    })

    const result = await uploader.upload('/tmp/Everlook.lua')
    expect(result.unchanged).toBe(false)
    expect(request).toHaveBeenCalledTimes(4)
    expect(saved).toHaveBeenCalledWith('/tmp/Everlook.lua', result.hash, result.uploadedAt)
  })

  it('skips the object put when Everlook reports a duplicate world file', async () => {
    const contents = Buffer.from('new worldFile')
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ upload: { duplicate: true, status: 'completed' } }), { status: 202 })
      )
    const uploader = new UploadCoordinator({
      previousHash: () => null,
      token: async () => 'a'.repeat(64),
      baseUrl: () => 'https://everlook.example',
      saved: vi.fn(),
      readStable: async () => contents,
      request,
      sleep: async () => undefined
    })

    const result = await uploader.upload('/tmp/Everlook.lua')
    expect(result.unchanged).toBe(false)
    expect(describeUpload(result)).toContain('duplicate')
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('keeps earlier replies when Everlook rejects the queued file', async () => {
    const contents = Buffer.from('new worldFile')
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            message: 'World file accepted for upload.',
            upload: {
              id: 18,
              status: 'pending',
              duplicate: false,
              key: '2026/09/16/01ARZ3NDEKTSV4RRFFQ69G5FAV.lua',
              url: 'https://r2.example/signed?X-Amz-Signature=secret',
              headers: { 'Content-Type': 'text/x-lua' },
              method: 'PUT'
            }
          }),
          { status: 202 }
        )
      )
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            message: 'The given data was invalid.',
            errors: { key: ['The uploaded world file could not be found.'] }
          }),
          { status: 422 }
        )
      )
    const uploader = new UploadCoordinator({
      previousHash: () => null,
      token: async () => 'a'.repeat(64),
      baseUrl: () => 'https://everlook.example',
      saved: vi.fn(),
      readStable: async () => contents,
      request,
      sleep: async () => undefined
    })

    const error = await uploader.upload('/tmp/Everlook.lua').then(
      () => {
        throw new Error('Expected the queued upload to be rejected.')
      },
      (caught: unknown) => caught
    )

    expect(error).toBeInstanceOf(UploadError)
    const responses = error instanceof UploadError ? error.responses : []
    const described = describeUpload({ unchanged: false, responses })
    expect(described).toContain('Check 202')
    expect(described).toContain('World file accepted for upload.')
    expect(described).toContain('Storage 200')
    expect(described).toContain('key: The uploaded world file could not be found.')
    expect(described).not.toContain('X-Amz-Signature')
    expect(described).not.toContain('r2.example')
    expect(error).toMatchObject({
      message: 'Everlook rejected this world file: key: The uploaded world file could not be found.'
    })
  })
})
