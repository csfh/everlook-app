import type { FileState, UploadStatus } from '../shared/types'
import { accountName } from './discovery'

export type FileRuntime = {
  lastDetectedAt?: string | null
  status?: UploadStatus
  error?: string | null
  response?: string | null
  signed?: 'signed' | 'unsigned' | null
}

type FileHistoryMark = {
  path: string
  outcome: 'uploaded' | 'unchanged' | 'error'
  signed: 'signed' | 'unsigned' | null
}

/**
 * The file list the window shows.
 * A live row owns the signature, even before one is known, so an older history mark cannot flash back.
 * The first history mark for a path is the one that counts. Recovery returns the newest first.
 */
export function projectFileStates(input: {
  selectedFiles: readonly string[]
  uploads: Readonly<Record<string, { hash: string; uploadedAt: string }>>
  runtime: ReadonlyMap<string, FileRuntime>
  history: readonly FileHistoryMark[]
  autoWatch: boolean
}): FileState[] {
  return input.selectedFiles.map((filePath) => {
    const current = input.runtime.get(filePath)
    const upload = input.uploads[filePath]
    const last = input.history.find((entry) => entry.path === filePath)
    return {
      path: filePath,
      account: accountName(filePath),
      lastDetectedAt: current?.lastDetectedAt ?? null,
      lastUploadedAt: upload?.uploadedAt ?? null,
      lastUploadedHash: upload?.hash ?? null,
      status: current?.status ?? last?.outcome ?? (input.autoWatch ? 'watching' : 'idle'),
      error: current?.error ?? null,
      response: current?.response ?? null,
      signed: current !== undefined ? current.signed ?? null : last?.signed ?? null
    }
  })
}
