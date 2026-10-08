import type { AddonInstallState, InstallationState, SigningState } from '../shared/types'
import {
  addonsDirectoryFromWorldFile,
  addonStatusFromProbe,
  discoverAddonsDirectories,
  fetchPublishedAddon,
  inspectInstalledAddon,
  type PublishedAddon
} from './addon-install'
import { resolveSigningState } from './signing-status'
import { canWriteSigningToken, readPlacedToken, readSavedSigner } from './signing-token'

export type InstallationCatalog = {
  installations: InstallationState[]
  addon: AddonInstallState
  signing: SigningState
}

/**
 * One read of the configured Forever installs.
 * Each row's signing uses only the world files in that install.
 * Account signing also counts signers from selected files that match no install.
 * A failed version check leaves the published version empty and still returns the installs.
 */
export async function loadInstallationCatalog(input: {
  selectedFiles: readonly string[]
  roots: readonly string[]
  baseUrl: string
  accountSigner: string | null
  fetch: typeof fetch
}): Promise<InstallationCatalog> {
  const selectedFiles = [...input.selectedFiles]
  const directories = await discoverAddonsDirectories(selectedFiles, [...input.roots])
  let published: PublishedAddon | null
  try {
    published = await fetchPublishedAddon(input.baseUrl, input.fetch)
  } catch {
    published = null
  }
  const signers = new Map(await Promise.all([...new Set(selectedFiles)].map(async (file) => {
    return [file, await readSavedSigner(file)] as const
  })))
  const signerFor = (file: string): string | null => signers.get(file) ?? null
  const probed = await Promise.all(directories.map(async (addonsDirectory) => {
    const installed = await inspectInstalledAddon(addonsDirectory)
    const files = selectedFiles.filter((file) => addonsDirectoryFromWorldFile(file) === addonsDirectory)
    const placed = installed.present ? (await readPlacedToken(addonsDirectory))?.fingerprint ?? null : null
    const skipped = installed.present ? !(await canWriteSigningToken(addonsDirectory)) : false
    const state = {
      status: addonStatusFromProbe(installed, published),
      addonsPath: addonsDirectory,
      version: installed.version,
      publishedVersion: published?.version ?? null,
      title: installed.title ?? published?.title ?? null,
      interface: installed.interface ?? published?.interface ?? null,
      error: null,
      files,
      signing: resolveSigningState({
        installs: installed.present ? [{ addonsDirectory, placed, skipped }] : [],
        accountSigner: input.accountSigner,
        savedSigners: files.map(signerFor)
      })
    } satisfies InstallationState
    return { addonsDirectory, present: installed.present, placed, skipped, state }
  }))
  const signing = resolveSigningState({
    installs: probed.flatMap((installation) => installation.present ? [{
      addonsDirectory: installation.addonsDirectory,
      placed: installation.placed,
      skipped: installation.skipped
    }] : []),
    accountSigner: input.accountSigner,
    savedSigners: selectedFiles.map(signerFor)
  })
  const installations = probed.map((installation) => installation.state)
  return { installations, addon: addonSummary(installations[0], published), signing }
}

/**
 * A finished upload rereads signers. A failed version check reports the addon
 * as behind, so this keeps the status already shown and takes only signing and files.
 * An install the reread did not return stays as it was. A newly discovered install waits for a full read.
 */
export function retainInstallStatus(
  current: readonly InstallationState[],
  next: Pick<InstallationCatalog, 'installations' | 'signing'>
): { installations: InstallationState[]; signing: SigningState } {
  const replacements = new Map(next.installations.map((installation) => [installation.addonsPath, installation]))
  return {
    signing: next.signing,
    installations: current.map((installation) => {
      const replacement = installation.addonsPath === null ? undefined : replacements.get(installation.addonsPath)
      if (replacement === undefined) return installation
      return { ...installation, signing: replacement.signing, files: replacement.files }
    })
  }
}

/** The one AddOns directory an install or token action applies to. */
export function resolveAddonDirectory(directories: readonly string[], addonsPath?: string): string {
  if (addonsPath !== undefined) {
    if (!directories.includes(addonsPath)) throw new Error('This installation is not configured.')
    return addonsPath
  }
  const [only] = directories
  if (only === undefined || directories.length !== 1) throw new Error('Choose an installation to update.')
  return only
}

function addonSummary(installation: InstallationState | undefined, published: PublishedAddon | null): AddonInstallState {
  if (installation === undefined) {
    return {
      status: 'missing',
      addonsPath: null,
      version: null,
      publishedVersion: published?.version ?? null,
      title: null,
      interface: null,
      error: null
    }
  }
  return {
    status: installation.status,
    addonsPath: installation.addonsPath,
    version: installation.version,
    publishedVersion: installation.publishedVersion,
    title: installation.title,
    interface: installation.interface,
    error: installation.error
  }
}
