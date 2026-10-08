import { FolderSearchIcon, KeyRoundIcon, PuzzleIcon, RefreshCwIcon } from 'lucide-react'
import { toast } from 'sonner'
import type { AppState, InstallationState } from '../../../shared/types'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle
} from '@/components/ui/card'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle
} from '@/components/ui/empty'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { Spinner } from '@/components/ui/spinner'
import { installationFlavor, installationsOf } from '@/desktop-state'
import { addonActionLabel, addonActionName, addonCopy, fileStatusLabel, signingActionLabel, signingActionName, signingCopy } from '@/status'
import { ViewTitle } from '@/views/form-parts'

type InstallationProps = {
  appState: AppState
  busy: boolean
  act: (operation: () => Promise<void>) => Promise<void>
}

export function AddonsView(props: InstallationProps) {
  return (
    <section className="flex flex-col gap-4" aria-labelledby="addons-heading">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <ViewTitle
          id="addons-heading"
          title="Addons"
          description="Install Everlook and place its signing token for each WoW installation."
        />
        <Button
          variant="outline"
          disabled={props.busy}
          onClick={() => void props.act(window.everlook.refreshInstallations)}
        >
          <RefreshCwIcon data-icon="inline-start" />
          Refresh
        </Button>
      </div>
      <InstallationCards {...props} />
    </section>
  )
}

export function InstallationCards({ appState, busy, act }: InstallationProps) {
  const installations = installationsOf(appState)
  if (installations.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <PuzzleIcon />
          </EmptyMedia>
          <EmptyTitle>Choose your WoW installation</EmptyTitle>
          <EmptyDescription>
            Choose the WoW root or game flavor folder. You can install the addon before an
            Everlook.lua export exists.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button variant="outline" disabled={busy} onClick={() => void act(window.everlook.chooseRoot)}>
            <FolderSearchIcon data-icon="inline-start" />
            Choose WoW root
          </Button>
        </EmptyContent>
      </Empty>
    )
  }
  return (
    <div className="flex flex-col gap-4">
      {installations.map((installation, index) => (
        <InstallationCard
          key={installation.addonsPath ?? index}
          installation={installation}
          appState={appState}
          busy={busy}
          act={act}
        />
      ))}
    </div>
  )
}

function InstallationCard({
  installation,
  appState,
  busy,
  act
}: InstallationProps & { installation: InstallationState }) {
  const addonsPath = installation.addonsPath
  const flavor = installationFlavor(addonsPath)
  const actionLabel = addonActionLabel(installation)
  const tokenLabel = signingActionLabel(installation.signing)
  const where = addonsPath ?? 'this installation'
  const actionName = addonActionName(installation, where)
  const tokenName = signingActionName(installation.signing, where)
  const disabled = busy || !appState.authenticated || addonsPath === null

  async function placeToken(): Promise<void> {
    if (addonsPath === null) return
    const result = await window.everlook.placeSigningToken(addonsPath)
    if (result.placed > 0) {
      toast.success('Signing token placed', {
        description: 'Start WoW and log out once so the addon can sign a save.'
      })
    } else {
      toast('Signing token skipped', {
        description: 'Signing token file protection could not be verified. In a dev checkout, sign.lua must be ignored and untracked.'
      })
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2 className="flex flex-wrap items-center gap-2">
            WoW installation
            {flavor ? <Badge variant="secondary">{flavor}</Badge> : null}
          </h2>
        </CardTitle>
        <CardDescription className="break-all">
          {addonsPath ?? 'Choose an installation folder'}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p aria-live="polite">{addonCopy(installation)}</p>
          {actionLabel ? (
            <Button
              variant="outline"
              disabled={disabled || installation.status === 'installing'}
              aria-label={actionName ?? undefined}
              onClick={() => void act(() => window.everlook.installAddon(addonsPath ?? undefined))}
            >
              {installation.status === 'installing' ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <PuzzleIcon data-icon="inline-start" />
              )}
              {actionLabel}
            </Button>
          ) : null}
        </div>
        <Separator />
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0 flex-1">
            <h3 className="font-medium">Signing token</h3>
            <p className="text-muted-foreground text-sm" aria-live="polite">
              {signingCopy(installation.signing)}
            </p>
          </div>
          {tokenLabel ? (
            <Button
              variant="outline"
              disabled={disabled || installation.status === 'missing' || installation.status === 'installing'}
              aria-label={tokenName ?? undefined}
              onClick={() => void act(placeToken)}
            >
              <KeyRoundIcon data-icon="inline-start" />
              {tokenLabel}
            </Button>
          ) : null}
        </div>
        {installation.signing.error ? (
          <Alert variant="destructive">
            <AlertTitle>Signing needs attention</AlertTitle>
            <AlertDescription>{installation.signing.error}</AlertDescription>
          </Alert>
        ) : null}
        {installation.files.length > 0 ? (
          <ul className="flex flex-col gap-3" aria-label="Exports in this installation">
            {installation.files.map((filePath) => {
              const file = appState.files.find((candidate) => candidate.path === filePath)
              return (
                <li key={filePath} className="flex flex-col gap-1">
                  <p className="break-all font-mono text-xs">{filePath}</p>
                  <p className="text-muted-foreground text-sm">
                    {file ? `${file.account} · ${fileStatusLabel(file.status)}` : 'Export found'}
                  </p>
                </li>
              )
            })}
          </ul>
        ) : (
          <Badge variant="outline" className="w-fit">No export yet</Badge>
        )}
      </CardContent>
      <CardFooter>
        <p className="text-muted-foreground text-sm">
          {installation.files.length === 0
            ? 'Enable Everlook in WoW, then log out or use /reload to create the first export.'
            : 'Everlook uploads when WoW finishes saving the export.'}
        </p>
      </CardFooter>
    </Card>
  )
}
