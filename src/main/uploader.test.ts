import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { describeUpload, readStableWorldFile, UNSTABLE_WORLD_FILE_CODE, UploadCoordinator, UploadError, uploadOutcome } from './uploader'

/** A world file as it is uploaded: the keys the site reads, written the way the uploader writes them. */
const slim = (text: string): Buffer => Buffer.from(`EverlookDB = {\r\n["world"] = "${text}",\r\n}\r\n`)

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
    const uploader = new UploadCoordinator({ previousHash: () => null, token: async () => 'a'.repeat(64), baseUrl: () => 'https://everlook.example', saved: vi.fn(), readStable: async () => slim('world'), request, sleep: vi.fn() })
    await expect(uploader.upload('/tmp/Everlook.lua')).rejects.toMatchObject({ httpStatus: 429, retryAfterMs: 60_000 })
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('carries security_required beside the HTTP status', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      code: 'security_required',
      message: 'Add a passkey and an authenticator app to upload.',
      setup_url: 'https://everlook.example/account/security'
    }), { status: 403 }))
    const uploader = new UploadCoordinator({ previousHash: () => null, token: async () => 'a'.repeat(64), baseUrl: () => 'https://everlook.example', saved: vi.fn(), readStable: async () => slim('world'), request, sleep: vi.fn() })
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
    const uploader = new UploadCoordinator({ previousHash: () => null, token: async () => 'a'.repeat(64), baseUrl: () => 'https://everlook.example', saved: vi.fn(), readStable: async () => slim('world'), request, sleep: vi.fn() })
    await expect(uploader.upload('/tmp/Everlook.lua')).rejects.toMatchObject({
      httpStatus: 403,
      code: 'contributions_revoked',
      setupUrl: null
    })
  })

  it('sends the problem reports in the file once, even when the file holds no world yet', async () => {
    const withReports = Buffer.from('EverlookDB = {\r\n["reports"] = {\r\n{ ["id"] = "a1b2c3d4", ["at"] = 1, ["text"] = "Broken", ["facts"] = "Everlook 1" }, -- [1]\r\n},\r\n}\r\n', 'latin1')
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ stored: 1, new: 1 }), { status: 200 }))
    const uploader = new UploadCoordinator({ previousHash: () => null, token: async () => 'a'.repeat(64), baseUrl: () => 'https://everlook.example', saved: vi.fn(), readStable: async () => withReports, request, sleep: vi.fn() })
    await expect(uploader.upload('/tmp/Everlook.lua')).rejects.toMatchObject({ code: 'ENODATA' })
    await expect(uploader.upload('/tmp/Everlook.lua')).rejects.toMatchObject({ code: 'ENODATA' })
    expect(request).toHaveBeenCalledTimes(1)
    const [url, init] = request.mock.calls[0]!
    expect(url).toBe('https://everlook.example/api/desktop/addon/reports')
    expect(JSON.parse(String(init?.body))).toEqual({ reports: [{ id: 'a1b2c3d4', at: 1, text: 'Broken', facts: 'Everlook 1' }] })
  })

  it('does not let a failed report send stop the world upload, and tries the report again', async () => {
    const withBoth = Buffer.from('EverlookDB = {\r\n["reports"] = {\r\n{ ["id"] = "a1b2c3d4", ["at"] = 1, ["text"] = "Broken", ["facts"] = "f" }, -- [1]\r\n},\r\n["manifest"] = "2;1;b;l;1;v;npcs.0.0=1:' + 'a'.repeat(64) + '",\r\n}\r\n', 'latin1')
    const request = vi.fn<typeof fetch>().mockImplementation(async (input) =>
      String(input).endsWith('/reports') ? new Response('down', { status: 500 }) : new Response('busy', { status: 429, headers: { 'Retry-After': '60' } }))
    const uploader = new UploadCoordinator({ previousHash: () => null, token: async () => 'a'.repeat(64), baseUrl: () => 'https://everlook.example', saved: vi.fn(), readStable: async () => withBoth, request, sleep: vi.fn() })
    await expect(uploader.upload('/tmp/Everlook.lua')).rejects.toMatchObject({ httpStatus: 429 })
    await expect(uploader.upload('/tmp/Everlook.lua')).rejects.toMatchObject({ httpStatus: 429 })
    expect(request.mock.calls.filter(([url]) => String(url).endsWith('/reports'))).toHaveLength(2)
  })

  describe('the journey', () => {
    const token = 'aaaa1111bbbb2222'
    const second = 'cccc3333dddd4444'
    const signature = 'f'.repeat(64)
    const chunk = (from: number, to: number): string => `{ ["from"] = ${from}, ["to"] = ${to}, ["payload"] = "2r.P${from}", ["signature"] = "${signature}" }, -- [x]`
    const journeyFile = (...chunks: string[]): Buffer => Buffer.from(
      `EverlookDB = {\r\n["journey"] = { ["v"] = 1, ["signer"] = "0123456789abcdef", ["characters"] = {\r\n["${token}"] = { ["chunks"] = {\r\n${chunks.join('\r\n')}\r\n} },\r\n} },\r\n["manifest"] = "2;1;b;l;1;v;npcs.0.0=1:${'a'.repeat(64)}",\r\n}\r\n`, 'latin1')
    const journeyCalls = (request: ReturnType<typeof vi.fn<typeof fetch>>) => request.mock.calls.filter(([url]) => String(url).endsWith('/api/desktop/addon/journey'))
    const coordinator = (contents: Buffer, request: typeof fetch, cursors: Record<string, number>, journeySaved: (next: Record<string, number>) => Promise<void> = vi.fn(async () => undefined)) => ({
      journeySaved,
      uploader: new UploadCoordinator({ previousHash: () => null, token: async () => 'a'.repeat(64), baseUrl: () => 'https://everlook.example', saved: vi.fn(), readStable: async () => contents, request, sleep: vi.fn(), journeyCursors: () => cursors, journeySaved })
    })

    it('sends the chunks above the cursor with the signer, and remembers what the site decided on', async () => {
      const request = vi.fn<typeof fetch>().mockImplementation(async (input) => String(input).endsWith('/journey')
        ? new Response(JSON.stringify({ stored: 2, new: 7, rejected: 0 }), { status: 200 })
        : new Response('busy', { status: 429, headers: { 'Retry-After': '60' } }))
      const { uploader, journeySaved } = coordinator(journeyFile(chunk(1, 500), chunk(501, 1000), chunk(1001, 1200)), request, { [token]: 500 })

      await expect(uploader.upload('/tmp/Everlook.lua')).rejects.toMatchObject({ httpStatus: 429 })

      expect(journeyCalls(request)).toHaveLength(1)
      const [url, init] = journeyCalls(request)[0]!
      expect(url).toBe('https://everlook.example/api/desktop/addon/journey')
      expect(JSON.parse(String(init?.body))).toEqual({
        signer: '0123456789abcdef',
        chunks: [
          { from: 501, to: 1000, payload: '2r.P501', signature },
          { from: 1001, to: 1200, payload: '2r.P1001', signature }
        ]
      })
      expect(journeySaved).toHaveBeenCalledWith({ [token]: 1200 })
    })

    it('sends nothing when every chunk is at or below the cursor', async () => {
      const request = vi.fn<typeof fetch>().mockResolvedValue(new Response('busy', { status: 429, headers: { 'Retry-After': '60' } }))
      const { uploader, journeySaved } = coordinator(journeyFile(chunk(1, 500)), request, { [token]: 500 })

      await expect(uploader.upload('/tmp/Everlook.lua')).rejects.toMatchObject({ httpStatus: 429 })

      expect(journeyCalls(request)).toHaveLength(0)
      expect(journeySaved).not.toHaveBeenCalled()
    })

    it('sends at most ten chunks a request, oldest first', async () => {
      const chunks = Array.from({ length: 12 }, (_, index) => chunk(index * 10 + 1, index * 10 + 10))
      const request = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
        if (!String(input).endsWith('/journey')) return new Response('busy', { status: 429, headers: { 'Retry-After': '60' } })
        const sent = JSON.parse(String(init?.body)).chunks as { to: number }[]
        return new Response(JSON.stringify({ stored: sent.length, new: 0, rejected: 0 }), { status: 200 })
      })
      const { uploader, journeySaved } = coordinator(journeyFile(...chunks), request, {})

      await expect(uploader.upload('/tmp/Everlook.lua')).rejects.toMatchObject({ httpStatus: 429 })

      expect(journeyCalls(request).map(([, init]) => JSON.parse(String(init?.body)).chunks.length)).toEqual([10, 2])
      expect(journeySaved).toHaveBeenLastCalledWith({ [token]: 120 })
    })

    it('does not let a failed journey send stop the world upload, and sends the chunks again next time', async () => {
      const request = vi.fn<typeof fetch>().mockImplementation(async (input) => String(input).endsWith('/journey')
        ? new Response('down', { status: 500 })
        : new Response('busy', { status: 429, headers: { 'Retry-After': '60' } }))
      const { uploader, journeySaved } = coordinator(journeyFile(chunk(1, 500)), request, {})

      await expect(uploader.upload('/tmp/Everlook.lua')).rejects.toMatchObject({ httpStatus: 429 })
      await expect(uploader.upload('/tmp/Everlook.lua')).rejects.toMatchObject({ httpStatus: 429 })

      expect(journeyCalls(request)).toHaveLength(2)
      expect(journeySaved).not.toHaveBeenCalled()
    })

    it('stops sending journey chunks for the run when the site refuses one, so a bad chunk is not hammered', async () => {
      const request = vi.fn<typeof fetch>().mockImplementation(async (input) => String(input).endsWith('/journey')
        ? new Response(JSON.stringify({ code: 'quota_exceeded' }), { status: 429, headers: { 'Retry-After': '3600' } })
        : new Response('busy', { status: 429, headers: { 'Retry-After': '60' } }))
      const chunks = Array.from({ length: 12 }, (_, index) => chunk(index * 10 + 1, index * 10 + 10))
      const { uploader } = coordinator(journeyFile(...chunks), request, {})

      await expect(uploader.upload('/tmp/Everlook.lua')).rejects.toMatchObject({ httpStatus: 429 })

      expect(journeyCalls(request)).toHaveLength(1)
    })

    it('moves past a chunk the site rejected, so it does not stand in front of the ones after it', async () => {
      const request = vi.fn<typeof fetch>().mockImplementation(async (input) => String(input).endsWith('/journey')
        ? new Response(JSON.stringify({ stored: 1, new: 3, rejected: 1 }), { status: 200 })
        : new Response('busy', { status: 429, headers: { 'Retry-After': '60' } }))
      const cursors: Record<string, number> = {}
      const saved = vi.fn(async (next: Record<string, number>) => { Object.assign(cursors, next) })
      const { uploader } = coordinator(journeyFile(chunk(1, 500), chunk(501, 600)), request, cursors, saved)

      await expect(uploader.upload('/tmp/Everlook.lua')).rejects.toMatchObject({ httpStatus: 429 })
      expect(saved).toHaveBeenCalledWith({ [token]: 600 })

      await expect(uploader.upload('/tmp/Everlook.lua')).rejects.toMatchObject({ httpStatus: 429 })
      expect(journeyCalls(request)).toHaveLength(1)
    })

    it('tracks each character on its own', async () => {
      const both = Buffer.from(
        `EverlookDB = {\r\n["journey"] = { ["signer"] = "0123456789abcdef", ["characters"] = {\r\n["${token}"] = { ["chunks"] = { ${chunk(1, 5)} } },\r\n["${second}"] = { ["chunks"] = { ${chunk(1, 9)} } },\r\n} },\r\n["manifest"] = "2;1;b;l;1;v;npcs.0.0=1:${'a'.repeat(64)}",\r\n}\r\n`, 'latin1')
      const request = vi.fn<typeof fetch>().mockImplementation(async (input) => String(input).endsWith('/journey')
        ? new Response(JSON.stringify({ stored: 1, new: 1, rejected: 0 }), { status: 200 })
        : new Response('busy', { status: 429, headers: { 'Retry-After': '60' } }))
      const { uploader, journeySaved } = coordinator(both, request, { [token]: 5 })

      await expect(uploader.upload('/tmp/Everlook.lua')).rejects.toMatchObject({ httpStatus: 429 })

      expect(JSON.parse(String(journeyCalls(request)[0]![1]?.body)).chunks).toHaveLength(1)
      expect(journeySaved).toHaveBeenCalledWith({ [token]: 5, [second]: 9 })
    })
  })

  it('leaves a plain 403 without a body code', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response('denied', { status: 403 }))
    const uploader = new UploadCoordinator({ previousHash: () => null, token: async () => 'a'.repeat(64), baseUrl: () => 'https://everlook.example', saved: vi.fn(), readStable: async () => slim('world'), request, sleep: vi.fn() })
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
    const uploader = new UploadCoordinator({ previousHash: () => null, token: async () => 'a'.repeat(64), baseUrl: () => 'https://everlook.example', saved, readStable: async () => slim('world'), request })
    await expect(uploader.upload('/tmp/Everlook.lua', { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(saved).not.toHaveBeenCalled()
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('hashes before upload and skips an unchanged world file', async () => {
    const contents = slim('worldFile')
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
    const contents = slim('worldFile')
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
    const contents = slim('new worldFile')
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
    expect(putInit?.body).toEqual(contents)
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
    const contents = slim('new worldFile')
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
    const contents = slim('new worldFile')
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
    const contents = slim('new worldFile')
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
