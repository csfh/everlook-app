import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import type { AppState } from '../../shared/types'
import { AppLogoIcon } from '@/components/app-logo-icon'
import { TitleBar } from '@/components/title-bar'
import { Spinner } from '@/components/ui/spinner'
import { Tabs, TabsContent } from '@/components/ui/tabs'
import { UpdateChip } from '@/update-panel'
import { SetupView } from '@/views/setup'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { AddonsView } from '@/views/addons'
import { LauncherView } from '@/views/launcher'
import { SettingsView } from '@/views/settings'
import { UploadsView } from '@/views/uploads'

type AppView = 'setup' | 'uploads' | 'launcher' | 'addons' | 'settings'

export default function App() {
  const [appState, setAppState] = useState<AppState | null>(null)
  const [baseUrl, setBaseUrl] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [view, setView] = useState<AppView>('setup')
  const readyUpdate = useRef<string | null>(null)
  const seenUpdateError = useRef<string | null>(null)

  useEffect(() => {
    void window.everlook.getState().then((next) => {
      setAppState(next)
      setBaseUrl(next.settings.baseUrl)
      if (next.authenticated && next.files.length > 0) setView('uploads')
    }).catch((caught: unknown) => setError(caught instanceof Error ? caught.message : 'Could not load Everlook.'))
    return window.everlook.onState((next) => {
      setAppState(next)
      setBaseUrl(next.settings.baseUrl)
    })
  }, [])

  useEffect(() => {
    if (appState?.update.status !== 'ready' || appState.update.availableVersion === null) return
    const version = appState.update.availableVersion
    if (readyUpdate.current === version) return
    readyUpdate.current = version
    toast('An Everlook update is ready', {
      id: 'update-ready',
      description: `Version ${version} is downloaded. Restart after any upload finishes.`,
      duration: Infinity,
      action: {
        label: 'Install and restart',
        onClick: () => {
          void window.everlook.installUpdate().catch((caught: unknown) => {
            toast.error('Could not restart', {
              description:
                caught instanceof Error
                  ? caught.message
                  : 'Try Install and restart again.'
            })
          })
        }
      }
    })
  }, [appState?.update.availableVersion, appState?.update.status])

  useEffect(() => {
    if (appState?.update.status !== 'error' || appState.update.error === null) {
      if (appState?.update.status !== 'error') seenUpdateError.current = null
      return
    }
    const message = appState.update.error
    if (seenUpdateError.current === message) return
    seenUpdateError.current = message
    toast.error('Could not update Everlook', { id: 'update-error', description: message })
  }, [appState?.update.error, appState?.update.status])

  const sessionOnly = appState?.credentialStorage === 'session'
  useEffect(() => {
    if (!sessionOnly) return
    toast.warning('Login lasts until Everlook closes', {
      id: 'session-login',
      description: 'Everlook could not save your sign-in on this computer.'
    })
  }, [sessionOnly])

  async function act(operation: () => Promise<void>): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      await operation()
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'The operation failed.'
      setError(message)
      toast.error('That did not finish', { description: message })
    } finally {
      setBusy(false)
    }
  }

  async function launchOrStopWow(): Promise<void> {
    if (appState?.capabilities?.nativeBattleNet) {
      await window.everlook.openNativeLauncher()
      return
    }
    if (appState?.wow.status === 'running') {
      await window.everlook.stopWow()
      return
    }
    const result = await window.everlook.launchWow()
    if (result.status === 'already-running') {
      toast('WoW is already running', {
        description: 'This session is still up. Stop it from the title bar before starting another.'
      })
    }
  }

  if (appState === null) {
    return (
      <div className="flex h-full flex-col bg-background">
        <TitleBar
          authenticated={false}
          busy={true}
          wow={null}
          onWow={() => undefined}
        />
        <main className="flex flex-1 items-center justify-center p-6">
          {error ? (
            <Alert variant="destructive">
              <AlertTitle>Could not open Everlook</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : (
            <div className="loading-panel flex w-full max-w-sm flex-col gap-4 rounded-xl bg-muted/25 p-6 ring-1 ring-foreground/10">
            <AppLogoIcon className="size-14" />
            <div className="flex flex-col gap-2">
              <h1 className="text-xl font-medium tracking-tight">Opening Everlook</h1>
              <p className="text-muted-foreground text-sm text-pretty">
                Reading the saved sign-in and the files this window is watching.
              </p>
            </div>
            <p className="text-muted-foreground flex items-center gap-3 text-sm">
              <Spinner />
              This usually takes a moment.
            </p>
            </div>
          )}
        </main>
      </div>
    )
  }

  const uploading = appState.files.some((file) => file.status === 'uploading')

  const authenticated = appState.authenticated

  return (
    <Tabs
      value={!authenticated && view !== 'settings' ? 'setup' : view}
      onValueChange={(next) => {
        if (next === 'setup' || next === 'uploads' || next === 'launcher' || next === 'addons' || next === 'settings') setView(next)
      }}
      className="h-full gap-0 bg-background"
    >
      <TitleBar
        authenticated={authenticated}
        busy={busy}
        wow={appState.wow}
        {...(appState.capabilities === undefined ? {} : { capabilities: appState.capabilities })}
        update={
          <UpdateChip update={appState.update} uploading={uploading} busy={busy} act={act} />
        }
        onWow={() => void act(launchOrStopWow)}
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 py-6">
          {error ? (
            <Alert variant="destructive">
              <AlertTitle>That did not finish</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          {appState.accountError && view !== 'setup' && view !== 'settings' ? (
            <Alert variant="destructive">
              <AlertTitle>Account verification needs attention</AlertTitle>
              <AlertDescription className="flex flex-col gap-2">
                <p>{appState.accountError}</p>
                <Button
                  variant="outline"
                  className="w-fit"
                  disabled={busy}
                  onClick={() => void act(window.everlook.login)}
                >
                  Sign in again
                </Button>
              </AlertDescription>
            </Alert>
          ) : null}
          <TabsContent value="setup">
            <SetupView
              appState={appState}
              baseUrl={baseUrl}
              setBaseUrl={setBaseUrl}
              busy={busy}
              act={act}
              onUploads={() => setView('uploads')}
            />
          </TabsContent>
          <TabsContent value="uploads">
            <UploadsView appState={appState} busy={busy} act={act} />
          </TabsContent>
          <TabsContent value="launcher">
            <LauncherView
              appState={appState}
              busy={busy}
              act={act}
              onWow={() => void act(launchOrStopWow)}
            />
          </TabsContent>
          <TabsContent value="addons">
            <AddonsView appState={appState} busy={busy} act={act} />
          </TabsContent>
          <TabsContent value="settings">
            <SettingsView
              appState={appState}
              baseUrl={baseUrl}
              setBaseUrl={setBaseUrl}
              busy={busy}
              uploading={uploading}
              act={act}
            />
          </TabsContent>
        </main>
      </div>
    </Tabs>
  )
}
