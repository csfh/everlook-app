import type { FileState } from './types'

export type StatusTone = 'ok' | 'busy' | 'error' | 'idle'

export function relativeTime(
  value: string | null,
  now: Date = new Date(),
  locales?: Intl.LocalesArgument
): string {
  if (value === null) return 'never'
  const seconds = Math.max(0, Math.floor((now.getTime() - new Date(value).getTime()) / 1000))
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return hours === 1 ? '1 hour ago' : `${hours} hours ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return days === 1 ? '1 day ago' : `${days} days ago`
  return new Intl.DateTimeFormat(locales, { dateStyle: 'medium' }).format(new Date(value))
}

function plural(count: number, noun: string): string {
  return count === 1 ? `1 ${noun}` : `${count} ${noun}s`
}

export function uploadsSummary(
  files: FileState[],
  autoWatch: boolean,
  now: Date = new Date()
): { tone: StatusTone; headline: string; detail: string } {
  if (files.length === 0) {
    return {
      tone: 'idle',
      headline: 'No files yet',
      detail: 'Choose a WoW install or add Everlook.lua files.'
    }
  }

  const uploading = files.filter((file) => file.status === 'uploading').length
  const failed = files.filter((file) => file.status === 'error').length
  const latest = files
    .map((file) => file.lastUploadedAt)
    .filter((time): time is string => time !== null)
    .sort()
    .at(-1)
  const detail =
    latest === undefined ? 'Nothing uploaded yet.' : `Last upload ${relativeTime(latest, now)}.`

  if (uploading > 0) return { tone: 'busy', headline: `Uploading ${plural(uploading, 'file')}`, detail }
  if (failed > 0) {
    return { tone: 'error', headline: `${plural(failed, 'file')} failed to upload`, detail }
  }
  if (!autoWatch) {
    return { tone: 'idle', headline: `${plural(files.length, 'file')}, automatic upload off`, detail }
  }
  return { tone: 'ok', headline: `Watching ${plural(files.length, 'file')}`, detail }
}
