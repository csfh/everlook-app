import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { CredentialStorage } from '../shared/types'

export type TokenCipher = {
  encrypt: (plainText: string) => Promise<Buffer>
  decrypt: (encrypted: Buffer) => Promise<string>
}

export type SafeStorageLike = {
  isEncryptionAvailable: () => boolean
  isAsyncEncryptionAvailable?: () => Promise<boolean>
  setUsePlainTextEncryption?: (usePlainText: boolean) => void
  encryptString?: (plainText: string) => Buffer
  encryptStringAsync?: (plainText: string) => Promise<Buffer>
  decryptString?: (encrypted: Buffer) => string
  decryptStringAsync?: (
    encrypted: Buffer
  ) => Promise<string | { result: string; shouldReEncrypt?: boolean }>
}

const KEYRING_BACKENDS = new Set(['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'])
const TOKEN_PATTERN = /^[a-fA-F0-9]{64}$/

export function enableLinuxPlainTextEncryption(storage: {
  setUsePlainTextEncryption?: (usePlainText: boolean) => void
}): void {
  if (typeof storage.setUsePlainTextEncryption !== 'function') return
  try {
    storage.setUsePlainTextEncryption(true)
  } catch (error) {
    logStoreError('Could not enable plaintext credential encryption.', error)
  }
}

export async function probeSafeStorage(storage: {
  isEncryptionAvailable: () => boolean
  isAsyncEncryptionAvailable?: () => Promise<boolean>
}): Promise<boolean> {
  if (storage.isEncryptionAvailable()) return true
  if (storage.isAsyncEncryptionAvailable === undefined) return false
  try {
    return await storage.isAsyncEncryptionAvailable()
  } catch (error) {
    logStoreError('Could not probe credential encryption.', error)
    return false
  }
}

export function resolveCredentialStorage(input: {
  platform: NodeJS.Platform
  encryptionAvailable: boolean
  linuxBackend?: string
}): CredentialStorage {
  if (input.platform !== 'linux') {
    return input.encryptionAvailable ? 'os-keyring' : 'user-file'
  }
  if (
    input.encryptionAvailable &&
    input.linuxBackend !== undefined &&
    KEYRING_BACKENDS.has(input.linuxBackend)
  ) {
    return 'os-keyring'
  }
  return 'user-file'
}

export function createSafeStorageCipher(
  storage: Pick<
    SafeStorageLike,
    'encryptString' | 'encryptStringAsync' | 'decryptString' | 'decryptStringAsync'
  >
): TokenCipher {
  return {
    async encrypt(plainText) {
      if (storage.encryptStringAsync !== undefined) {
        return storage.encryptStringAsync(plainText)
      }
      if (storage.encryptString !== undefined) {
        return storage.encryptString(plainText)
      }
      throw new Error('safeStorage encrypt is unavailable.')
    },
    async decrypt(encrypted) {
      if (storage.decryptStringAsync !== undefined) {
        const value = await storage.decryptStringAsync(encrypted)
        if (typeof value === 'string') return value
        return value.result
      }
      if (storage.decryptString !== undefined) {
        return storage.decryptString(encrypted)
      }
      throw new Error('safeStorage decrypt is unavailable.')
    }
  }
}

export class TokenStore {
  private readonly encryptedPath: string
  private readonly plainPath: string
  private readonly cipher: TokenCipher | null
  private readonly preferredStorage: CredentialStorage
  private effectiveStorage: CredentialStorage
  private memoryToken: string | null = null
  private memoryLoaded = false
  private generation = 0
  private diskMutations: Promise<void> = Promise.resolve()

  constructor(
    userDataPath: string,
    options: { cipher: TokenCipher | null; credentialStorage: CredentialStorage }
  ) {
    this.encryptedPath = path.join(userDataPath, 'token.enc')
    this.plainPath = path.join(userDataPath, 'token')
    this.cipher = options.cipher
    this.preferredStorage = options.credentialStorage
    this.effectiveStorage = options.credentialStorage
  }

  credentialStorage(): CredentialStorage {
    return this.effectiveStorage
  }

  async get(): Promise<string | null> {
    if (this.memoryLoaded) return this.memoryToken
    const generation = this.generation

    if (this.cipher !== null) {
      const decrypted = await this.readEncrypted()
      if (generation !== this.generation) return this.memoryToken
      if (decrypted !== null) {
        this.memoryToken = decrypted
        this.memoryLoaded = true
        return decrypted
      }
    }

    const plain = await this.readPlain()
    if (generation !== this.generation) return this.memoryToken
    this.memoryToken = plain
    this.memoryLoaded = true
    return plain
  }

  async set(token: string): Promise<void> {
    const generation = ++this.generation
    this.memoryToken = token
    this.memoryLoaded = true
    this.effectiveStorage = this.preferredStorage
    await this.mutateDisk(() => this.writeToken(token, generation))
  }

  async clear(): Promise<void> {
    ++this.generation
    this.memoryToken = null
    this.memoryLoaded = true
    this.effectiveStorage = this.preferredStorage
    await this.mutateDisk(async () => {
      await rm(this.encryptedPath, { force: true })
      await rm(this.plainPath, { force: true })
    })
  }

  flush(): Promise<void> {
    return this.diskMutations
  }

  private mutateDisk(mutation: () => Promise<void>): Promise<void> {
    const operation = this.diskMutations.then(mutation)
    // The caller receives rejection; only the queue barrier recovers so the next mutation can run.
    this.diskMutations = operation.then(() => undefined, () => undefined)
    return operation
  }

  private async writeToken(token: string, generation: number): Promise<void> {

    if (this.cipher !== null) {
      try {
        const encrypted = await this.cipher.encrypt(token)
        await writePrivateFile(this.encryptedPath, encrypted)
        await rm(this.plainPath, { force: true })
        return
      } catch (error) {
        logStoreError('Could not encrypt the Everlook credential; saving a user-only file instead.', error)
      }
    }

    try {
      await writePrivateFile(this.plainPath, token)
      await rm(this.encryptedPath, { force: true })
      if (generation === this.generation) this.effectiveStorage = 'user-file'
    } catch (error) {
      if (generation === this.generation) this.effectiveStorage = 'session'
      logStoreError('Could not save the Everlook credential on disk.', error)
    }
  }

  private async readEncrypted(): Promise<string | null> {
    if (this.cipher === null) return null
    try {
      const encrypted = await readFile(this.encryptedPath)
      const decrypted = await this.cipher.decrypt(encrypted)
      return parsedToken(decrypted)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logStoreError('Could not decrypt the saved Everlook credential.', error)
      }
      return null
    }
  }

  private async readPlain(): Promise<string | null> {
    try {
      return parsedToken((await readFile(this.plainPath, 'utf8')).trim())
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logStoreError('Could not read the saved Everlook credential.', error)
      }
      return null
    }
  }
}

function parsedToken(value: string): string | null {
  return TOKEN_PATTERN.test(value) ? value : null
}

function logStoreError(message: string, error: unknown): void {
  const code =
    typeof error === 'object' && error !== null && 'code' in error && error.code != null
      ? String(error.code)
      : ''
  if (code !== '') {
    console.error(message, code)
    return
  }
  console.error(message)
}

async function writePrivateFile(filePath: string, contents: Buffer | string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true })
  const temporaryPath = `${filePath}.tmp`
  await writeFile(temporaryPath, contents, { mode: 0o600 })
  await chmod(temporaryPath, 0o600)
  await rename(temporaryPath, filePath)
}
