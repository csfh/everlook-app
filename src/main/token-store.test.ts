import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createSafeStorageCipher,
  enableLinuxPlainTextEncryption,
  probeSafeStorage,
  resolveCredentialStorage,
  TokenStore,
  type TokenCipher
} from './token-store'

const temporaryDirectories: string[] = []
const token = 'a'.repeat(64)

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })))
})

async function makeDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'everlook-token-'))
  temporaryDirectories.push(directory)
  return directory
}

function xorCipher(): TokenCipher {
  return {
    async encrypt(plainText) {
      const bytes = Buffer.from(plainText, 'utf8')
      const encrypted = Buffer.alloc(bytes.length)
      for (let index = 0; index < bytes.length; index += 1) {
        encrypted[index] = (bytes[index] ?? 0) ^ 0x5a
      }
      return encrypted
    },
    async decrypt(encrypted) {
      const plain = Buffer.alloc(encrypted.length)
      for (let index = 0; index < encrypted.length; index += 1) {
        plain[index] = (encrypted[index] ?? 0) ^ 0x5a
      }
      return plain.toString('utf8')
    }
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  const pending: { resolve?: (value: T) => void } = {}
  const promise = new Promise<T>((resolve) => { pending.resolve = resolve })
  return {
    promise,
    resolve(value) {
      if (pending.resolve === undefined) throw new Error('Deferred promise is not initialized.')
      pending.resolve(value)
    }
  }
}

describe('resolveCredentialStorage', () => {
  it('uses the OS keyring when Linux reports a real backend', () => {
    expect(
      resolveCredentialStorage({
        platform: 'linux',
        encryptionAvailable: true,
        linuxBackend: 'gnome_libsecret'
      })
    ).toBe('os-keyring')
    expect(
      resolveCredentialStorage({
        platform: 'linux',
        encryptionAvailable: true,
        linuxBackend: 'kwallet6'
      })
    ).toBe('os-keyring')
  })

  it('falls back to a user file on Hyprland-style basic_text or missing encryption', () => {
    expect(
      resolveCredentialStorage({
        platform: 'linux',
        encryptionAvailable: true,
        linuxBackend: 'basic_text'
      })
    ).toBe('user-file')
    expect(
      resolveCredentialStorage({
        platform: 'linux',
        encryptionAvailable: false,
        linuxBackend: 'unknown'
      })
    ).toBe('user-file')
  })

  it('treats macOS and Windows encryption as an OS keyring', () => {
    expect(resolveCredentialStorage({ platform: 'darwin', encryptionAvailable: true })).toBe(
      'os-keyring'
    )
    expect(resolveCredentialStorage({ platform: 'win32', encryptionAvailable: true })).toBe(
      'os-keyring'
    )
  })
})

describe('enableLinuxPlainTextEncryption', () => {
  it('calls setUsePlainTextEncryption when Electron exposes it', () => {
    const setUsePlainTextEncryption = vi.fn()
    enableLinuxPlainTextEncryption({ setUsePlainTextEncryption })
    expect(setUsePlainTextEncryption).toHaveBeenCalledWith(true)
  })

  it('skips hosts that have no plaintext API', () => {
    expect(() => enableLinuxPlainTextEncryption({})).not.toThrow()
  })
})

describe('probeSafeStorage', () => {
  it('prefers the synchronous availability flag', async () => {
    const isAsyncEncryptionAvailable = vi.fn(async () => false)
    await expect(
      probeSafeStorage({
        isEncryptionAvailable: () => true,
        isAsyncEncryptionAvailable
      })
    ).resolves.toBe(true)
    expect(isAsyncEncryptionAvailable).not.toHaveBeenCalled()
  })

  it('asks the async encryptor when the sync flag is false', async () => {
    await expect(
      probeSafeStorage({
        isEncryptionAvailable: () => false,
        isAsyncEncryptionAvailable: async () => true
      })
    ).resolves.toBe(true)
  })
})

describe('createSafeStorageCipher', () => {
  it('reads decryptStringAsync result objects from Electron 44', async () => {
    const cipher = createSafeStorageCipher({
      encryptStringAsync: async (plainText) => Buffer.from(`enc:${plainText}`),
      decryptStringAsync: async (encrypted) => ({
        result: encrypted.toString('utf8').slice(4),
        shouldReEncrypt: false
      })
    })

    const encrypted = await cipher.encrypt(token)
    await expect(cipher.decrypt(encrypted)).resolves.toBe(token)
  })
})

describe('TokenStore', () => {
  it('serializes a delayed encrypted save before logout and clears memory immediately', async () => {
    const directory = await makeDirectory()
    const started = deferred<void>()
    const release = deferred<void>()
    const cipher: TokenCipher = {
      encrypt: async (value) => {
        started.resolve()
        await release.promise
        return Buffer.from(value)
      },
      decrypt: async (value) => value.toString('utf8')
    }
    const store = new TokenStore(directory, { cipher, credentialStorage: 'os-keyring' })
    const saving = store.set(token)
    await started.promise
    const clearing = store.clear()
    const immediateToken = await store.get()
    release.resolve()
    await Promise.all([saving, clearing])

    expect(immediateToken).toBeNull()
    await expect(store.get()).resolves.toBeNull()
    await expect(readFile(path.join(directory, 'token.enc'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(path.join(directory, 'token'))).rejects.toMatchObject({ code: 'ENOENT' })
    const restarted = new TokenStore(directory, { cipher, credentialStorage: 'os-keyring' })
    await expect(restarted.get()).resolves.toBeNull()
  })

  it('keeps the newest credential after overlapping saves and a reload', async () => {
    const directory = await makeDirectory()
    const newerToken = 'b'.repeat(64)
    const started = deferred<void>()
    const release = deferred<void>()
    const encrypt = vi.fn(async (value: string) => {
      if (value === token) {
        started.resolve()
        await release.promise
      }
      return Buffer.from(value)
    })
    const cipher: TokenCipher = { encrypt, decrypt: async (value) => value.toString('utf8') }
    const store = new TokenStore(directory, { cipher, credentialStorage: 'os-keyring' })
    const olderSave = store.set(token)
    await started.promise
    const newerSave = store.set(newerToken)
    const immediateToken = await store.get()
    const callsWhileFirstPending = encrypt.mock.calls.length
    release.resolve()
    await Promise.all([olderSave, newerSave])

    expect(immediateToken).toBe(newerToken)
    expect(callsWhileFirstPending).toBe(1)
    const restarted = new TokenStore(directory, { cipher, credentialStorage: 'os-keyring' })
    await expect(restarted.get()).resolves.toBe(newerToken)
  })

  it.each(['set', 'clear'] as const)('does not let an in-flight read restore old credentials after %s', async (mutation) => {
    const directory = await makeDirectory()
    await writeFile(path.join(directory, 'token.enc'), token)
    const started = deferred<void>()
    const release = deferred<void>()
    const cipher: TokenCipher = {
      encrypt: async (value) => Buffer.from(value),
      decrypt: async (value) => {
        started.resolve()
        await release.promise
        return value.toString('utf8')
      }
    }
    const store = new TokenStore(directory, { cipher, credentialStorage: 'os-keyring' })
    const loading = store.get()
    await started.promise
    const expected = mutation === 'set' ? 'b'.repeat(64) : null
    if (expected === null) await store.clear()
    else await store.set(expected)
    const immediateToken = await store.get()
    release.resolve()
    expect(immediateToken).toBe(expected)
    await expect(loading).resolves.toBe(expected)
    await expect(store.get()).resolves.toBe(expected)
  })

  it.each(['set', 'clear'] as const)('does not let an older encryption fallback replace a newer %s storage generation', async (mutation) => {
    const directory = await makeDirectory()
    const started = deferred<void>()
    const release = deferred<void>()
    const cipher: TokenCipher = {
      encrypt: async (value) => {
        if (value !== token) return Buffer.from(value)
        started.resolve()
        await release.promise
        throw new Error('keyring unavailable')
      },
      decrypt: async (value) => value.toString('utf8')
    }
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const store = new TokenStore(directory, { cipher, credentialStorage: 'os-keyring' })
    const saving = store.set(token)
    await started.promise
    const newerToken = 'b'.repeat(64)
    const nextMutation = mutation === 'clear' ? store.clear() : store.set(newerToken)
    release.resolve()
    await Promise.all([saving, nextMutation])

    expect(store.credentialStorage()).toBe('os-keyring')
    await expect(store.get()).resolves.toBe(mutation === 'clear' ? null : newerToken)
    await expect(readFile(path.join(directory, 'token'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('surfaces a failed clear and continues serializing subsequent mutations', async () => {
    const directory = await makeDirectory()
    const store = new TokenStore(directory, { cipher: null, credentialStorage: 'user-file' })
    await store.set(token)
    const blockedPath = path.join(directory, 'token.enc')
    await mkdir(blockedPath)
    await expect(store.clear()).rejects.toThrow()
    await expect(store.get()).resolves.toBeNull()
    await rm(blockedPath, { recursive: true })
    const newerToken = 'b'.repeat(64)
    await store.set(newerToken)
    const restarted = new TokenStore(directory, { cipher: null, credentialStorage: 'user-file' })
    await expect(restarted.get()).resolves.toBe(newerToken)
  })

  it('waits for queued credential removal before shutdown finishes', async () => {
    const directory = await makeDirectory()
    const started = deferred<void>()
    const release = deferred<void>()
    const cipher: TokenCipher = {
      encrypt: async (value) => {
        started.resolve()
        await release.promise
        return Buffer.from(value)
      },
      decrypt: async (value) => value.toString('utf8')
    }
    const store = new TokenStore(directory, { cipher, credentialStorage: 'os-keyring' })
    const saving = store.set(token)
    await started.promise
    const clearing = store.clear()
    let finished = false
    const flushing = store.flush().then(() => { finished = true })
    await Promise.resolve()
    expect(finished).toBe(false)
    release.resolve()
    await Promise.all([saving, clearing, flushing])

    expect(finished).toBe(true)
    const restarted = new TokenStore(directory, { cipher, credentialStorage: 'os-keyring' })
    await expect(restarted.get()).resolves.toBeNull()
  })

  it('persists through safeStorage and rereads after a new store instance', async () => {
    const directory = await makeDirectory()
    const cipher = xorCipher()
    const store = new TokenStore(directory, { cipher, credentialStorage: 'os-keyring' })
    await store.set(token)

    const encrypted = await readFile(path.join(directory, 'token.enc'))
    expect(encrypted.toString('utf8')).not.toContain(token)
    if (process.platform !== 'win32') expect((await stat(path.join(directory, 'token.enc'))).mode & 0o777).toBe(0o600)
    expect(store.credentialStorage()).toBe('os-keyring')

    const restarted = new TokenStore(directory, { cipher, credentialStorage: 'os-keyring' })
    await expect(restarted.get()).resolves.toBe(token)
  })

  it('writes a user-only file when encryption is unavailable', async () => {
    const directory = await makeDirectory()
    const store = new TokenStore(directory, { cipher: null, credentialStorage: 'user-file' })
    await store.set(token)

    const filePath = path.join(directory, 'token')
    expect(await readFile(filePath, 'utf8')).toBe(token)
    if (process.platform !== 'win32') expect((await stat(filePath)).mode & 0o777).toBe(0o600)
    expect(store.credentialStorage()).toBe('user-file')

    const restarted = new TokenStore(directory, { cipher: null, credentialStorage: 'user-file' })
    await expect(restarted.get()).resolves.toBe(token)
  })

  it('falls back to the user-only file when encrypt fails', async () => {
    const directory = await makeDirectory()
    const store = new TokenStore(directory, {
      cipher: {
        encrypt: async () => {
          throw new Error(`encrypt failed for ${token}`)
        },
        decrypt: async () => token
      },
      credentialStorage: 'os-keyring'
    })
    const logged: string[] = []
    vi.spyOn(console, 'error').mockImplementation((...args) => {
      logged.push(args.map(String).join(' '))
    })

    await store.set(token)
    expect(await readFile(path.join(directory, 'token'), 'utf8')).toBe(token)
    expect(store.credentialStorage()).toBe('user-file')
    expect(logged.join('\n')).not.toContain(token)
  })

  it('keeps a session token when disk writes fail', async () => {
    const directory = await makeDirectory()
    const blockedDirectory = path.join(directory, 'not-a-directory')
    await writeFile(blockedDirectory, 'blocked')
    const store = new TokenStore(blockedDirectory, { cipher: null, credentialStorage: 'user-file' })
    await store.set(token)
    expect(store.credentialStorage()).toBe('session')
    await expect(store.get()).resolves.toBe(token)
  })

  it('clears encrypted and plaintext files', async () => {
    const directory = await makeDirectory()
    const store = new TokenStore(directory, { cipher: xorCipher(), credentialStorage: 'os-keyring' })
    await store.set(token)
    await writeFile(path.join(directory, 'token'), token, { mode: 0o600 })
    await store.clear()
    await expect(readFile(path.join(directory, 'token.enc'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(path.join(directory, 'token'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(store.get()).resolves.toBeNull()
  })
})
