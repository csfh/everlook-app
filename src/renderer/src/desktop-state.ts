import type { AppState, InstallationState, PendingUpload, UploadHistoryEntry } from '../../shared/types'

export function installationsOf(state: Pick<AppState, 'addon' | 'signing' | 'files' | 'installations'>): InstallationState[] {
  if (state.installations !== undefined) return state.installations
  if (state.addon.addonsPath === null) return []
  return [{ ...state.addon, signing: state.signing, files: state.files.map((file) => file.path) }]
}

/** The pending upload's reason, when the file row would otherwise only point at that list. */
export function fileAttention(
  file: { path: string; status: string; error: string | null },
  pending: readonly { path: string; error: string | null }[]
): string | null {
  if (file.status !== 'error' && file.error === null) return null
  const reason = pending.find((entry) => entry.path === file.path && entry.error !== null)?.error
  return reason ?? file.error
}

export function pendingLabel(status: PendingUpload['status']): string {
  const labels: Record<PendingUpload['status'], string> = {
    queued: 'Queued', uploading: 'Uploading', retrying: 'Waiting to retry',
    'auth-required': 'Sign in to resume', 'security-required': 'Secure account to resume',
    'contributions-revoked': 'Contributions revoked',
    blocked: 'Needs attention'
  }
  return labels[status]
}

export function historyOutcome(entry: UploadHistoryEntry): { label: string; ingest: string | null; failed: boolean } {
  const label = entry.outcome === 'uploaded' ? 'Uploaded to Everlook' : entry.outcome === 'unchanged' ? 'Already uploaded' : 'Upload failed'
  const ingest = entry.ingestStatus === null ? null : `Ingest ${entry.ingestStatus}`
  return { label, ingest, failed: entry.outcome === 'error' || entry.ingestStatus === 'failed' }
}

export function firstExportStatus(filePath: string, history: readonly UploadHistoryEntry[]): { label: string; complete: boolean; unsigned: boolean; error?: string | null } {
  const latest = history.filter((entry) => entry.path === filePath).sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0]
  if (latest === undefined) return { label: 'Waiting for the first upload', complete: false, unsigned: false }
  if (latest.outcome === 'error') return { label: 'Upload needs attention', complete: false, unsigned: false, error: latest.error }
  if (latest.ingestStatus === 'failed') return { label: 'Server processing needs attention', complete: false, unsigned: false, error: latest.error }
  if (latest.ingestStatus === 'rejected') return { label: 'Server rejected this export', complete: false, unsigned: false, error: latest.error }
  if (latest.signed === 'unsigned') return { label: 'Waiting for a signed export', complete: false, unsigned: true }
  if (latest.signed !== 'signed') return { label: 'Waiting for signature verification', complete: false, unsigned: false }
  if (latest.ingestStatus !== 'completed') return { label: 'Waiting for server processing', complete: false, unsigned: false }
  return { label: 'Signature verified · Server processing complete', complete: true, unsigned: false }
}

/** The game folder an AddOns path sits in, such as `forever` for `…/_forever_/Interface/AddOns`. */
export function installationFlavor(addonsPath: string | null): string | null {
  if (addonsPath === null) return null
  const parts = addonsPath.split(/[\\/]/).filter((part) => part !== '')
  const interfaceAt = parts.map((part) => part.toLowerCase()).lastIndexOf('interface')
  const folder = interfaceAt > 0 ? parts[interfaceAt - 1] : undefined
  if (folder === undefined) return null
  return folder.replace(/^_+|_+$/g, '').replace(/_/g, ' ') || null
}
