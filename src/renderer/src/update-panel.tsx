import { DownloadIcon, RefreshCwIcon, TriangleAlertIcon } from 'lucide-react'
import type { UpdateState } from '../../shared/types'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverHeader, PopoverTitle, PopoverTrigger } from '@/components/ui/popover'
import { Progress } from '@/components/ui/progress'
import { Spinner } from '@/components/ui/spinner'
import { updateChipLabel, updateCopy, updateErrorDetail } from '@/status'

export function UpdateChip({
  update,
  uploading,
  busy,
  act
}: {
  update: UpdateState
  uploading: boolean
  busy: boolean
  act: (operation: () => Promise<void>) => Promise<void>
}) {
  const label = updateChipLabel(update)
  if (label === null) return null
  const failed = update.status === 'error'
  const ready = update.status === 'ready'
  const manualDownload = update.mode === 'manual' && update.status === 'available'
  const detail = updateErrorDetail(update)

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant={failed ? 'destructive' : 'outline'} className="app-no-drag">
          {failed ? (
            <TriangleAlertIcon data-icon="inline-start" />
          ) : ready || manualDownload ? (
            <DownloadIcon data-icon="inline-start" />
          ) : (
            <Spinner data-icon="inline-start" />
          )}
          {label}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72">
        <PopoverHeader>
          <PopoverTitle>
            {update.availableVersion ? `Version ${update.availableVersion}` : 'Everlook update'}
          </PopoverTitle>
        </PopoverHeader>
        <p className="text-muted-foreground text-sm text-pretty">{updateCopy(update)}</p>
        {detail ? <p className="text-sm text-pretty">{detail}</p> : null}
        {update.status === 'downloading' ? (
          <Progress
            value={update.downloadPercent ?? 0}
            aria-label={
              update.downloadPercent === null
                ? 'Downloading update'
                : `Downloading update, ${update.downloadPercent} percent`
            }
          />
        ) : null}
        {ready ? (
          <Button disabled={busy || uploading} onClick={() => void act(window.everlook.installUpdate)}>
            Install and restart
          </Button>
        ) : null}
        {manualDownload ? (
          <Button disabled={busy} onClick={() => void act(window.everlook.installUpdate)}>
            <DownloadIcon data-icon="inline-start" />
            Download update
          </Button>
        ) : null}
        {failed ? (
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => void act(window.everlook.checkForUpdates)}
          >
            Try again
          </Button>
        ) : null}
      </PopoverContent>
    </Popover>
  )
}

export function UpdateSettings({
  update,
  uploading,
  busy,
  act
}: {
  update: UpdateState
  uploading: boolean
  busy: boolean
  act: (operation: () => Promise<void>) => Promise<void>
}) {
  const checking = update.status === 'checking' || update.status === 'downloading'
  const ready = update.status === 'ready'
  const unavailable = update.status === 'unavailable'
  const manualDownload = update.mode === 'manual' && update.status === 'available'
  const detail = updateErrorDetail(update)

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
      <div className="flex min-w-0 flex-1 basis-56 flex-col gap-2">
        <p className="text-sm text-pretty" aria-live="polite">
          {updateCopy(update)}
        </p>
        {detail ? <p className="text-destructive-foreground text-sm">{detail}</p> : null}
        {update.status === 'downloading' ? (
          <Progress
            value={update.downloadPercent ?? 0}
            aria-label={
              update.downloadPercent === null
                ? 'Downloading update'
                : `Downloading update, ${update.downloadPercent} percent`
            }
          />
        ) : null}
      </div>
      {ready ? (
        <Button variant="gold" disabled={busy || uploading} onClick={() => void act(window.everlook.installUpdate)}>
          <DownloadIcon data-icon="inline-start" />
          Install and restart
        </Button>
      ) : manualDownload ? (
        <Button variant="gold" disabled={busy} onClick={() => void act(window.everlook.installUpdate)}>
          <DownloadIcon data-icon="inline-start" />
          Download update
        </Button>
      ) : (
        <Button
          variant="outline"
          className="tabular-nums"
          disabled={busy || checking || unavailable}
          onClick={() => void act(window.everlook.checkForUpdates)}
        >
          {checking ? <Spinner data-icon="inline-start" /> : <RefreshCwIcon data-icon="inline-start" />}
          {checkingLabel(update)}
        </Button>
      )}
    </div>
  )
}

function checkingLabel(update: UpdateState): string {
  if (update.status === 'checking') return 'Checking…'
  if (update.status === 'downloading') {
    return update.downloadPercent === null ? 'Downloading…' : `Downloading ${update.downloadPercent}%`
  }
  return 'Check for updates'
}
