import type { StatusTone } from '../../shared/upload-summary'
import type {
  CredentialStorage,
  AddonInstallState,
  SigningState,
  UpdateState,
  UploadStatus,
  WowLauncherState
} from '../../shared/types'

export function updateCopy(update: UpdateState): string {
  if (update.status === 'unavailable') {
    if (update.mode !== undefined) return 'Updates are unavailable in this build.'
    return 'Updates only work in the packaged AppImage. To try a feed in development, set EVERLOOK_UPDATE_URL.'
  }
  if (update.status === 'checking') return 'Checking for updates…'
  if (update.status === 'available') {
    if (update.mode === 'manual') return update.availableVersion ? `Version ${update.availableVersion} is available to download.` : 'An update is available to download.'
    return update.availableVersion
      ? `Version ${update.availableVersion} is available. Downloading…`
      : 'An update is available. Downloading…'
  }
  if (update.status === 'downloading') {
    const percent = update.downloadPercent === null ? '' : ` (${update.downloadPercent}%)`
    return update.availableVersion
      ? `Downloading version ${update.availableVersion}${percent}.`
      : `Downloading an update${percent}.`
  }
  if (update.status === 'ready') {
    return update.availableVersion
      ? `Version ${update.availableVersion} is ready. Install and restart after any upload finishes.`
      : 'An update is ready. Install and restart after any upload finishes.'
  }
  if (update.status === 'current') {
    return `${update.currentVersion} is up to date.`
  }
  if (update.status === 'error') return updateFailureCopy(update)
  return `This install is ${update.currentVersion}.`
}

/** A short status line. The saved error stays available as the longer detail. */
export function updateFailureCopy(update: UpdateState): string {
  const error = update.error ?? ''
  if (/could not be verified/i.test(error)) return 'The update could not be verified.'
  if (update.availableVersion !== null) {
    return `Version ${update.availableVersion} could not be downloaded.`
  }
  // A missing Mac build says "no download". That is still a check, not a failed transfer.
  if (/could not be downloaded|failed to download|download failed/i.test(error)) {
    return 'The update could not be downloaded.'
  }
  return 'Could not check for updates.'
}

/** The longer error, hidden when it only repeats the status line. */
export function updateErrorDetail(update: UpdateState): string | null {
  if (update.status !== 'error' || update.error === null || update.error === '') return null
  return update.error === updateCopy(update) ? null : update.error
}

export function addonCopy(addon: AddonInstallState): string {
  if (addon.status === 'checking') return 'Checking the installed Everlook addon…'
  if (addon.status === 'installing') return 'Installing Everlook into Interface/AddOns…'
  if (addon.status === 'current') {
    return addon.version ? `Everlook ${addon.version} is up to date.` : 'Everlook is up to date.'
  }
  if (addon.status === 'behind') {
    return addon.version
      ? `Everlook ${addon.version} is installed. A newer version is available.`
      : 'Everlook is installed. A newer version is available.'
  }
  if (addon.status === 'git') {
    return addon.version
      ? `Everlook ${addon.version} is a git checkout in ${addon.addonsPath ?? 'Interface/AddOns'}.`
      : `Everlook is a git checkout in ${addon.addonsPath ?? 'Interface/AddOns'}.`
  }
  if (addon.status === 'error') return addon.error ?? 'Could not check Everlook.'
  return 'Everlook is not in Interface/AddOns yet.'
}

export function wowLauncherActionLabel(wow: WowLauncherState): string {
  if (wow.status === 'starting') return 'Launching…'
  if (wow.status === 'stopping') return 'Stopping…'
  if (wow.status === 'running') return 'Stop WoW'
  return 'Launch WoW'
}

export function wowLauncherCopy(wow: WowLauncherState): string {
  if (wow.status === 'starting') return 'Starting Battle.net…'
  if (wow.status === 'stopping') return 'Stopping wow.sh…'
  if (wow.status === 'running') return 'Battle.net is running.'
  if (wow.status === 'error') return wow.error ?? 'Could not start wow.sh.'
  return 'Starts Battle.net through the wow.sh launcher.'
}

export function addonActionLabel(addon: AddonInstallState): string | null {
  if (addon.status === 'installing') return 'Installing Everlook…'
  if (addon.status === 'checking') return null
  if (addon.status === 'current' || addon.status === 'git') return null
  if (addon.status === 'behind') return 'Update'
  return 'Install'
}

/** Names the install and the action, so repeated buttons are distinct to a screen reader. */
export function addonActionName(addon: AddonInstallState, where: string): string | null {
  const label = addonActionLabel(addon)
  if (label === null) return null
  if (addon.status === 'installing') return `Installing Everlook in ${where}`
  if (addon.status === 'behind') return `Update Everlook in ${where}`
  return `Install Everlook in ${where}`
}

export { relativeTime, uploadsSummary } from '../../shared/upload-summary'
export type { StatusTone } from '../../shared/upload-summary'

export function formatDate(value: string | null, locales?: Intl.LocalesArgument): string {
  if (value === null) return 'Never'
  return new Intl.DateTimeFormat(locales, {
    dateStyle: 'medium',
    timeStyle: 'short'
  }).format(new Date(value))
}

export function shortHash(value: string | null): string {
  return value === null ? 'None' : `${value.slice(0, 12)}…`
}

const fileStatusLabels: Record<UploadStatus, string> = {
  idle: 'Not watched',
  watching: 'Watching',
  uploading: 'Uploading',
  uploaded: 'Uploaded',
  unchanged: 'Up to date',
  error: 'Failed'
}

export function fileStatusLabel(status: UploadStatus): string {
  return fileStatusLabels[status]
}

export function credentialNotice(
  storage: CredentialStorage
): { title: string; description: string } | null {
  if (storage === 'session') {
    return {
      title: 'Login lasts until Everlook closes',
      description: 'Credentials could not be saved on this computer.'
    }
  }
  if (storage === 'user-file') {
    return {
      title: 'Login is saved in a user-only file',
      description: 'This desktop has no OS keyring Everlook can use.'
    }
  }
  return null
}

export function fileStatusTone(status: UploadStatus): StatusTone {
  if (status === 'error') return 'error'
  if (status === 'uploading') return 'busy'
  if (status === 'idle') return 'idle'
  return 'ok'
}

export function updateChipLabel(update: UpdateState): string | null {
  if (update.status === 'ready') return 'Update ready'
  if (update.status === 'available') return 'Update found'
  if (update.status === 'downloading') {
    return update.downloadPercent === null ? 'Downloading update' : `Downloading ${update.downloadPercent}%`
  }
  if (update.status === 'error' && update.error !== null) return 'Update failed'
  return null
}

export function signingCopy(signing: SigningState): string {
  const code = signing.fingerprint ?? ''
  if (signing.status === 'verified') return `Verified · ${code}. The addon is signing with this token.`
  if (signing.status === 'placed') return `Placed · ${code}. Waiting for WoW to save.`
  if (signing.status === 'stale') return `Out of date · ${code}. Place the token again.`
  if (signing.status === 'skipped') return 'Skipped. Signing token file protection could not be verified.'
  return 'Not placed. The token ties your data to this account.'
}

export function signingTone(signing: SigningState): StatusTone {
  if (signing.status === 'verified') return 'ok'
  if (signing.status === 'stale') return 'error'
  return 'idle'
}

/** Null hides the button when this install is skipped and the token cannot be written safely. */
export function signingActionLabel(signing: SigningState): string | null {
  if (signing.status === 'skipped') return null
  if (signing.status === 'not_placed' || signing.status === 'unknown') return 'Place token'
  return 'Place again'
}

export function signingActionName(signing: SigningState, where: string): string | null {
  const label = signingActionLabel(signing)
  if (label === null) return null
  return label === 'Place again' ? `Place signing token again in ${where}` : `Place signing token in ${where}`
}

export function uploadActionName(file: { account: string; status: UploadStatus }): string {
  return file.status === 'uploading' ? `Uploading export for ${file.account}` : `Upload export for ${file.account}`
}

export function signedLabel(signed: 'signed' | 'unsigned'): string {
  return signed === 'signed' ? 'Signed' : 'Unsigned'
}

export function signedHint(signed: 'signed' | 'unsigned'): string {
  return signed === 'signed'
    ? 'Everlook matched this upload to your account.'
    : 'Everlook could not match this upload to your account. Place the signing token on the Addons tab.'
}
