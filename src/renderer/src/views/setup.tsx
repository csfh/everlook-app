import { useState, type ReactNode } from 'react'
import { ChevronDownIcon, FolderSearchIcon, KeyRoundIcon, LogInIcon, UploadIcon } from 'lucide-react'
import type { AppState } from '../../../shared/types'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle
} from '@/components/ui/card'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { FieldGroup } from '@/components/ui/field'
import { firstExportStatus, installationsOf } from '@/desktop-state'
import { InstallationCards } from '@/views/addons'
import { StepHeading, TextField, ViewTitle } from '@/views/form-parts'

/**
 * One numbered setup step. A finished step starts collapsed and shows its summary in place of
 * the instructions. Toggling it by hand holds until the step's done state changes again.
 */
function SetupStep({
  number,
  title,
  description,
  done,
  summary,
  children
}: {
  number: number
  title: string
  description: ReactNode
  done: boolean
  summary: string
  children: ReactNode
}) {
  const [choice, setChoice] = useState<{ done: boolean; open: boolean } | null>(null)
  const open = choice !== null && choice.done === done ? choice.open : !done

  return (
    <Collapsible asChild open={open} onOpenChange={(next) => setChoice({ done, open: next })}>
      <Card className="group/step">
        <CardHeader>
          <CardTitle>
            <h2>
              <CollapsibleTrigger className="-m-1 flex w-[calc(100%+0.5rem)] items-center gap-2 rounded-md p-1 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
                <span className="min-w-0 flex-1">
                  <StepHeading step={number} done={done}>{title}</StepHeading>
                </span>
                <ChevronDownIcon
                  aria-hidden="true"
                  className="text-muted-foreground size-4 shrink-0 transition-transform duration-150 group-data-[state=open]/step:rotate-180"
                />
              </CollapsibleTrigger>
            </h2>
          </CardTitle>
          <CardDescription>{open ? description : summary}</CardDescription>
        </CardHeader>
        <CollapsibleContent className="flex flex-col gap-(--card-spacing)">
          {children}
        </CollapsibleContent>
      </Card>
    </Collapsible>
  )
}

export function SetupView({
  appState,
  baseUrl,
  setBaseUrl,
  busy,
  act,
  onUploads
}: {
  appState: AppState
  baseUrl: string
  setBaseUrl: (value: string) => void
  busy: boolean
  act: (operation: () => Promise<void>) => Promise<void>
  onUploads: () => void
}) {
  const installations = installationsOf(appState)
  const exports = [...new Set([
    ...appState.files.map((file) => file.path),
    ...installations.flatMap((installation) => installation.files)
  ])]
  const hasExport = exports.length > 0
  const connected = appState.authenticated && !appState.accountError
  const complete = connected && hasExport &&
    installations.every((installation) => installation.files.length > 0) &&
    exports.every((filePath) => firstExportStatus(filePath, appState.history ?? []).complete)

  const prepared = installations.length > 0 && installations.every((installation) =>
    (installation.status === 'current' || installation.status === 'git') &&
    (installation.signing.status === 'placed' || installation.signing.status === 'verified')
  )

  async function login(): Promise<void> {
    if (baseUrl !== appState.settings.baseUrl) {
      await window.everlook.updateSettings({ baseUrl, autoWatch: appState.settings.autoWatch })
    }
    await window.everlook.login()
  }

  return (
    <section className="flex flex-col gap-4" aria-labelledby="setup-heading">
      <ViewTitle
        id="setup-heading"
        title="Setup"
        description="Connect your account and prepare each WoW installation. Return here any time you add another install."
      />
      <SetupStep
        number={1}
        title="Sign in"
        description="Your password stays in the browser."
        done={connected}
        summary={`Signed in${appState.account ? ` as ${appState.account.name}` : ''} to ${appState.settings.baseUrl}.`}
      >
        <CardContent>
          {appState.authenticated ? (
            <p>
              Signed in{appState.account ? ` as ${appState.account.name}` : ''} to {appState.settings.baseUrl}.
            </p>
          ) : (
            <FieldGroup>
              <TextField
                label="Everlook URL"
                type="url"
                value={baseUrl}
                onChange={setBaseUrl}
                disabled={busy}
              />
            </FieldGroup>
          )}
          {appState.accountError ? (
            <Alert variant="destructive" className="mt-3">
              <AlertTitle>Account verification needs attention</AlertTitle>
              <AlertDescription>{appState.accountError}</AlertDescription>
            </Alert>
          ) : null}
        </CardContent>
        <CardFooter>
          {connected ? (
            <Badge variant="secondary">Connected</Badge>
          ) : (
            <Button variant="gold" disabled={busy} onClick={() => void act(login)}>
              <LogInIcon data-icon="inline-start" />
              {appState.accountError ? 'Sign in again' : 'Continue in the browser'}
            </Button>
          )}
        </CardFooter>
      </SetupStep>
      <SetupStep
        number={2}
        title="Choose WoW"
        description="Choose a WoW root or game flavor folder before the first export. You can select it while signed out."
        done={installations.length > 0}
        summary={`${installations.length} installation${installations.length === 1 ? '' : 's'} found.`}
      >
        <CardContent>
          <p>
            {installations.length > 0
              ? `${installations.length} installation${installations.length === 1 ? '' : 's'} found.`
              : 'No WoW installation selected yet.'}
          </p>
        </CardContent>
        <CardFooter>
          <Button variant="outline" disabled={busy} onClick={() => void act(window.everlook.chooseRoot)}>
            <FolderSearchIcon data-icon="inline-start" />
            {installations.length > 0 ? 'Add another WoW root' : 'Choose WoW root'}
          </Button>
        </CardFooter>
      </SetupStep>
      <SetupStep
        number={3}
        title="Install the addon and place the signing token"
        description="Use the actions for each installation below. Sign in before placing the token."
        done={prepared}
        summary={installations.length === 1
          ? 'Everlook is installed and its signing token is placed.'
          : `Everlook is installed and its signing token is placed in all ${installations.length} installations.`}
      >
        <CardContent>
          <InstallationCards appState={appState} busy={busy} act={act} />
        </CardContent>
      </SetupStep>
      <SetupStep
        number={4}
        title="Create the first export"
        description="Start WoW, enable Everlook in the addon list, then log out or type /reload. WoW writes Everlook.lua after saving."
        done={complete}
        summary="Setup complete. Everlook verified your signature and finished processing the first export."
      >
        <CardContent className="flex flex-col gap-3">
          <p aria-live="polite">
            {complete
              ? 'Setup complete. Everlook verified your signature and finished processing the first export.'
              : hasExport
                ? 'First export found.'
                : 'Waiting for the first Everlook.lua export. You can leave this page open while you play.'}
          </p>
          {hasExport ? (
            <ul className="flex flex-col gap-4" aria-label="First export progress">
              {exports.map((filePath) => {
                const progress = firstExportStatus(filePath, appState.history ?? [])
                const installation = installations.find((candidate) => candidate.files.includes(filePath))
                const addonsPath = installation?.addonsPath
                return (
                  <li key={filePath} className="flex flex-col gap-2">
                    <p className="break-all font-mono text-xs">{filePath}</p>
                    <Badge variant={progress.complete ? 'secondary' : 'outline'} className="w-fit">
                      {progress.label}
                    </Badge>
                    {progress.error ? <p className="text-muted-foreground text-sm">{progress.error}</p> : null}
                    {progress.unsigned ? (
                      <>
                        <p className="text-muted-foreground text-sm">
                          Place the signing token for this installation, then use /reload or log out
                          of WoW to save another export.
                        </p>
                        {addonsPath ? (
                          <Button
                            variant="outline"
                            className="w-fit"
                            disabled={busy || !connected}
                            aria-label={`Place signing token in ${addonsPath} and save again`}
                            onClick={() => void act(async () => {
                              const result = await window.everlook.placeSigningToken(addonsPath)
                              if (result.placed === 0) {
                                throw new Error('The signing token could not be placed. Review its status in Addons.')
                              }
                            })}
                          >
                            <KeyRoundIcon data-icon="inline-start" />
                            Place token and save again
                          </Button>
                        ) : null}
                      </>
                    ) : null}
                  </li>
                )
              })}
            </ul>
          ) : null}
        </CardContent>
        <CardFooter>
          <Button variant="outline" disabled={busy || !appState.authenticated} onClick={onUploads}>
            <UploadIcon data-icon="inline-start" />
            Go to uploads
          </Button>
        </CardFooter>
      </SetupStep>
    </section>
  )
}
