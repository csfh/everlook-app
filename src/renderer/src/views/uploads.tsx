import {
  ChevronDownIcon,
  FilePlusIcon,
  FolderSearchIcon,
  PlusIcon,
  RefreshCwIcon,
  ShieldCheckIcon,
  UploadIcon
} from 'lucide-react'
import type { AppState } from '../../../shared/types'
import { FileRow } from '@/file-row'
import { StatusDot } from '@/components/status-dot'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle
} from '@/components/ui/empty'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { useNow } from '@/hooks/use-now'
import { fileAttention, historyOutcome, pendingLabel } from '@/desktop-state'
import { formatDate, uploadsSummary } from '@/status'
import { ViewTitle } from '@/views/form-parts'

export function UploadsView({
  appState,
  busy,
  act
}: {
  appState: AppState
  busy: boolean
  act: (operation: () => Promise<void>) => Promise<void>
}) {
  const now = useNow(30_000)
  const { files, settings } = appState
  const summary = uploadsSummary(files, settings.autoWatch, now)
  const pending = appState.pending ?? []
  const history = (appState.history ?? []).slice(0, 200)

  return (
    <section className="flex flex-col gap-4" aria-labelledby="uploads-heading">
      <ViewTitle
        id="uploads-heading"
        title="Uploads"
        description="Track local exports, queued uploads, and recent results."
      />
      {files.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <UploadIcon />
            </EmptyMedia>
            <EmptyTitle>Waiting for an Everlook.lua export</EmptyTitle>
            <EmptyDescription>
              Choose your WoW installation, install Everlook, and place the signing token in Setup.
              Log out of WoW or use /reload to create the first export.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" disabled={busy} onClick={() => void act(window.everlook.chooseRoot)}>
                <FolderSearchIcon data-icon="inline-start" />
                Choose WoW root
              </Button>
              <Button variant="outline" disabled={busy} onClick={() => void act(window.everlook.chooseFiles)}>
                <FilePlusIcon data-icon="inline-start" />
                Add files
              </Button>
            </div>
          </EmptyContent>
        </Empty>
      ) : (
        <>
          <div className="file-actions flex flex-wrap items-center gap-x-4 gap-y-3 rounded-xl bg-card px-4 py-3 ring-1 ring-foreground/10">
            <StatusDot tone={summary.tone} className="size-2.5" />
            <div className="min-w-0 flex-1 basis-48" aria-live="polite">
              <p className="text-sm font-medium">{summary.headline}</p>
              <p className="text-muted-foreground text-sm">{summary.detail}</p>
            </div>
            <div className="flex gap-2">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" disabled={busy}>
                    <PlusIcon data-icon="inline-start" />
                    Add
                    <ChevronDownIcon data-icon="inline-end" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuGroup>
                    <DropdownMenuItem onSelect={() => void act(window.everlook.chooseRoot)}>
                      <FolderSearchIcon />
                      Choose WoW root
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => void act(window.everlook.chooseFiles)}>
                      <FilePlusIcon />
                      Add files
                    </DropdownMenuItem>
                  </DropdownMenuGroup>
                </DropdownMenuContent>
              </DropdownMenu>
              <Button
                variant="gold"
                disabled={busy || !appState.authenticated}
                onClick={() => void act(window.everlook.uploadAll)}
              >
                <UploadIcon data-icon="inline-start" />
                Upload all
              </Button>
            </div>
          </div>
          <ul className="flex flex-col gap-2" aria-label="Watched exports">
            {files.map((file) => (
              <FileRow key={file.path} file={file} attention={fileAttention(file, pending)} now={now} busy={busy} act={act} />
            ))}
          </ul>
        </>
      )}
      <Card>
        <CardHeader>
          <CardTitle><h2>Pending uploads</h2></CardTitle>
          <CardDescription>
            {pending.length} pending. Failed transfers retry automatically when possible.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {pending.length === 0 ? (
            <p className="text-muted-foreground text-sm">No uploads are waiting.</p>
          ) : (
            <ul className="flex flex-col divide-y" aria-label="Pending uploads">
              {pending.map((entry) => (
                <li key={`${entry.scope}:${entry.path}`} className="flex flex-col gap-2 py-4 first:pt-0 last:pb-0">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <Badge variant={entry.status === 'blocked' ? 'destructive' : 'secondary'}>
                      {pendingLabel(entry.status)}
                    </Badge>
                    <div className="flex flex-wrap items-center gap-2">
                      {entry.status === 'security-required' && entry.setupUrl ? (
                        <Button
                          variant="outline"
                          disabled={busy}
                          onClick={() => {
                            const setupUrl = entry.setupUrl
                            if (setupUrl) void act(() => window.everlook.openSecuritySettings(setupUrl))
                          }}
                        >
                          <ShieldCheckIcon data-icon="inline-start" />
                          Open security settings
                        </Button>
                      ) : null}
                      {entry.status === 'contributions-revoked' ? null : (
                        <Button
                          variant="outline"
                          disabled={busy || !appState.authenticated || entry.status === 'uploading'}
                          aria-label={`Retry upload of ${entry.path}`}
                          onClick={() => void act(() => window.everlook.retryFile(entry.path))}
                        >
                          <RefreshCwIcon data-icon="inline-start" />
                          Retry now
                        </Button>
                      )}
                    </div>
                  </div>
                  <p className="break-all font-mono text-xs">{entry.path}</p>
                  <p className="text-muted-foreground text-sm">
                    {entry.attempts} attempt{entry.attempts === 1 ? '' : 's'}
                    {entry.nextAttemptAt ? ` · Next retry ${formatDate(entry.nextAttemptAt)}` : ''}
                  </p>
                  {entry.error ? (
                    <Alert variant="destructive">
                      <AlertTitle>Upload needs attention</AlertTitle>
                      <AlertDescription>{entry.error}</AlertDescription>
                    </Alert>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle><h2>Upload history</h2></CardTitle>
          <CardDescription>
            Last {history.length} results, up to 200. An upload can be accepted before the server processes its data.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {history.length === 0 ? (
            <p className="text-muted-foreground text-sm">Upload results will appear here.</p>
          ) : (
            <ol className="flex flex-col divide-y" aria-label="Recent upload results">
              {history.map((entry) => {
                const outcome = historyOutcome(entry)
                return (
                  <li key={entry.id} className="flex flex-col gap-2 py-4 first:pt-0 last:pb-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant={entry.outcome === 'error' ? 'destructive' : 'secondary'}>
                        {outcome.label}
                      </Badge>
                      {outcome.ingest ? (
                        <Badge variant={outcome.failed ? 'destructive' : 'outline'}>
                          {outcome.ingest}
                        </Badge>
                      ) : null}
                      {entry.signed ? (
                        <Badge variant="outline">{entry.signed === 'signed' ? 'Signed' : 'Unsigned'}</Badge>
                      ) : null}
                    </div>
                    <p className="break-all font-mono text-xs">{entry.path}</p>
                    <p className="text-muted-foreground text-sm">
                      {formatDate(entry.at)}
                      {entry.uploadId !== null ? ` · Upload #${entry.uploadId}` : ''}
                    </p>
                    {entry.error ? (
                      <Alert variant="destructive">
                        <AlertTitle>
                          {entry.outcome === 'error' ? 'Upload failed' : 'Server processing needs attention'}
                        </AlertTitle>
                        <AlertDescription>{entry.error}</AlertDescription>
                      </Alert>
                    ) : null}
                  </li>
                )
              })}
            </ol>
          )}
        </CardContent>
      </Card>
    </section>
  )
}
