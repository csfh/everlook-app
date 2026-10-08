import { ChevronDownIcon, EllipsisIcon, UploadIcon } from 'lucide-react'
import type { FileState } from '../../shared/types'
import { StatusDot } from '@/components/status-dot'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Badge } from '@/components/ui/badge'
import { Spinner } from '@/components/ui/spinner'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  fileStatusLabel,
  fileStatusTone,
  formatDate,
  relativeTime,
  shortHash,
  signedHint,
  signedLabel,
  uploadActionName
} from '@/status'

export function FileRow({
  file,
  attention,
  now,
  busy = false,
  act
}: {
  file: FileState
  attention?: string | null
  now: Date
  busy?: boolean
  act: (operation: () => Promise<void>) => Promise<void>
}) {
  const uploading = file.status === 'uploading'
  const error = attention === undefined ? file.error : attention

  return (
    <li className="file-row min-w-0 rounded-xl bg-card ring-1 ring-foreground/10">
      <Collapsible>
        <div className="flex items-center gap-3 px-4 py-3">
          <StatusDot tone={fileStatusTone(file.status)} />
          <div className="min-w-0 flex-1">
            <p className="text-muted-foreground truncate text-xs">
              {file.account} · {fileStatusLabel(file.status)}
            </p>
            <p
              className="mt-0.5 truncate font-mono text-sm leading-snug"
              title={file.path}
              dir="rtl"
            >
              <bdi dir="ltr">{file.path}</bdi>
            </p>
          </div>
          {file.signed !== null ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Badge variant={file.signed === 'signed' ? 'secondary' : 'outline'} tabIndex={0}>
                  <StatusDot tone={file.signed === 'signed' ? 'ok' : 'idle'} />
                  {signedLabel(file.signed)}
                </Badge>
              </TooltipTrigger>
              <TooltipContent sideOffset={6}>{signedHint(file.signed)}</TooltipContent>
            </Tooltip>
          ) : null}
          <Tooltip>
            <TooltipTrigger asChild>
              <p className="text-muted-foreground hidden shrink-0 text-sm min-[40rem]:block">
                {file.lastUploadedAt === null
                  ? 'Not uploaded'
                  : `Uploaded ${relativeTime(file.lastUploadedAt, now)}`}
              </p>
            </TooltipTrigger>
            <TooltipContent sideOffset={6}>{formatDate(file.lastUploadedAt)}</TooltipContent>
          </Tooltip>
          <Button
            variant="outline"
            disabled={busy || uploading}
            aria-label={uploadActionName(file)}
            onClick={() => void act(() => window.everlook.uploadFile(file.path))}
          >
            {uploading ? <Spinner data-icon="inline-start" /> : <UploadIcon data-icon="inline-start" />}
            {uploading ? 'Uploading…' : 'Upload now'}
          </Button>
          <CollapsibleTrigger asChild>
            <Button variant="ghost" size="icon" aria-label={`Details for ${file.account}`} className="group/details">
              <ChevronDownIcon className="transition-transform duration-150 group-aria-expanded/details:rotate-180" />
            </Button>
          </CollapsibleTrigger>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" aria-label={`More actions for ${file.account}`}>
                <EllipsisIcon />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuGroup>
                <DropdownMenuItem
                  disabled={busy || uploading}
                  onSelect={() => void act(() => window.everlook.removeFile(file.path))}
                >
                  Stop watching
                </DropdownMenuItem>
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        {error ? (
          <div className="mx-4 mb-3">
            <Alert variant="destructive">
              <AlertTitle>Upload failed</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          </div>
        ) : null}
        <CollapsibleContent>
          <dl className="grid gap-3 border-t px-4 py-3 text-sm min-[40rem]:grid-cols-3">
            <div className="min-w-0">
              <dt className="text-muted-foreground text-xs">Last change</dt>
              <dd className="mt-1">{formatDate(file.lastDetectedAt)}</dd>
            </div>
            <div className="min-w-0">
              <dt className="text-muted-foreground text-xs">Last upload</dt>
              <dd className="mt-1">{formatDate(file.lastUploadedAt)}</dd>
            </div>
            <div className="min-w-0">
              <dt className="text-muted-foreground text-xs">Uploaded hash</dt>
              <dd className="mt-1 font-mono" title={file.lastUploadedHash ?? undefined}>
                {file.lastUploadedHash === null ? 'Not uploaded' : shortHash(file.lastUploadedHash)}
              </dd>
            </div>
          </dl>
        </CollapsibleContent>
      </Collapsible>
    </li>
  )
}
