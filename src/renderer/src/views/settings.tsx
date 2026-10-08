import { FileDownIcon, LogInIcon, LogOutIcon } from 'lucide-react'
import type { AppState, Settings } from '../../../shared/types'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle
} from '@/components/ui/card'
import { FieldGroup } from '@/components/ui/field'
import { credentialNotice } from '@/status'
import { UpdateSettings } from '@/update-panel'
import { SaveBar, SwitchRow, TextField, ViewTitle } from '@/views/form-parts'

export function SettingsView({
  appState,
  baseUrl,
  setBaseUrl,
  busy,
  uploading,
  act
}: {
  appState: AppState
  baseUrl: string
  setBaseUrl: (value: string) => void
  busy: boolean
  uploading: boolean
  act: (operation: () => Promise<void>) => Promise<void>
}) {
  const urlDirty = baseUrl !== appState.settings.baseUrl
  const notice = credentialNotice(appState.credentialStorage)
  const notifications = appState.settings.notifications ?? { uploadFailures: false, updates: false }
  const startupSupported = appState.startup?.supported ?? appState.capabilities?.loginStartup ?? false
  const manualUpdate = appState.update.mode === 'manual'
  const mac = appState.capabilities?.platform === 'darwin'

  function save(patch: Partial<Pick<Settings, 'closeToTray' | 'startAtLogin' | 'notifications'>>): void {
    void act(() => window.everlook.updateSettings({
      baseUrl: appState.settings.baseUrl,
      autoWatch: appState.settings.autoWatch,
      ...patch
    }))
  }

  return (
    <section className="flex flex-col gap-4" aria-labelledby="settings-heading">
      <ViewTitle
        id="settings-heading"
        title="Settings"
        description="Connection, startup, notifications, updates, and your account."
      />
      <Card>
        <CardHeader>
          <CardTitle><h2>Connection</h2></CardTitle>
          <CardDescription>Choose when Everlook sends exports.</CardDescription>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <TextField
              label="Everlook URL"
              type="url"
              value={baseUrl}
              hint="Log out before you point this at another site."
              onChange={setBaseUrl}
              disabled={busy || appState.authenticated}
            />
            <SwitchRow
              id="auto-watch"
              label="Upload when Everlook.lua changes"
              description="Everlook waits until WoW stops writing the file, then sends it. Turn this off to upload from the Uploads tab."
              checked={appState.settings.autoWatch}
              disabled={busy}
              onCheckedChange={(autoWatch) => void act(() => window.everlook.updateSettings({
                baseUrl: appState.settings.baseUrl,
                autoWatch
              }))}
            />
          </FieldGroup>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle><h2>Window and startup</h2></CardTitle>
          <CardDescription>These options are off until you enable them.</CardDescription>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <SwitchRow
              id="close-to-tray"
              label="Keep running in the tray"
              description={mac
                ? 'macOS keeps Everlook running after its window closes. Use Quit Everlook to stop the app and its uploads.'
                : 'Closing the window hides it and uploads keep going. A system tray is required. Start Everlook again to bring the window back.'}
              checked={appState.settings.closeToTray}
              disabled={busy || mac}
              onCheckedChange={(closeToTray) => save({ closeToTray })}
            />
            <SwitchRow
              id="start-at-login"
              label="Start at login"
              description={startupSupported
                ? 'Open Everlook automatically when you sign in to this computer.'
                : 'Start at login is available in supported packaged builds.'}
              checked={appState.startup?.enabled ?? appState.settings.startAtLogin ?? false}
              disabled={busy || !startupSupported}
              onCheckedChange={(startAtLogin) => save({ startAtLogin })}
            />
          </FieldGroup>
          {appState.startup?.error ? (
            <Alert variant="destructive" className="mt-3">
              <AlertTitle>Startup needs attention</AlertTitle>
              <AlertDescription>{appState.startup.error}</AlertDescription>
            </Alert>
          ) : null}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle><h2>Notifications</h2></CardTitle>
          <CardDescription>Choose which desktop notifications Everlook may show.</CardDescription>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <SwitchRow
              id="notify-upload-failures"
              label="Notify when an upload fails"
              description="Show a desktop notification when an upload needs attention."
              checked={notifications.uploadFailures}
              disabled={busy}
              onCheckedChange={(uploadFailures) => save({ notifications: { ...notifications, uploadFailures } })}
            />
            <SwitchRow
              id="notify-updates"
              label={manualUpdate ? 'Notify when an update is available' : 'Notify when an update is ready'}
              description={manualUpdate
                ? 'Show a desktop notification when a new macOS DMG is available to download.'
                : 'Show a desktop notification when a downloaded update can be installed.'}
              checked={notifications.updates}
              disabled={busy}
              onCheckedChange={(updates) => save({ notifications: { ...notifications, updates } })}
            />
          </FieldGroup>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle><h2>Updates</h2></CardTitle>
          <CardDescription>Version {appState.update.currentVersion}</CardDescription>
        </CardHeader>
        <CardContent>
          <UpdateSettings update={appState.update} uploading={uploading} busy={busy} act={act} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle><h2>Account</h2></CardTitle>
          <CardDescription>
            {appState.authenticated
              ? `Signed in${appState.account ? ` as ${appState.account.name}` : ''} to ${appState.settings.baseUrl}.`
              : 'Sign in from Setup to resume uploads.'}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {appState.accountError ? (
            <Alert variant="destructive">
              <AlertTitle>Account verification needs attention</AlertTitle>
              <AlertDescription>{appState.accountError}</AlertDescription>
            </Alert>
          ) : null}
          {notice ? (
            <Alert>
              <AlertTitle>{notice.title}</AlertTitle>
              <AlertDescription>{notice.description}</AlertDescription>
            </Alert>
          ) : null}
          <p className="text-muted-foreground text-sm">Logging out stops uploads for this account.</p>
        </CardContent>
        <CardFooter className="flex flex-wrap gap-2">
          {appState.accountError ? (
            <Button variant="outline" disabled={busy} onClick={() => void act(window.everlook.login)}>
              <LogInIcon data-icon="inline-start" />
              Sign in again
            </Button>
          ) : null}
          <Button
            variant="outline"
            disabled={busy || !appState.authenticated}
            onClick={() => void act(window.everlook.logout)}
          >
            <LogOutIcon data-icon="inline-start" />
            Log out
          </Button>
        </CardFooter>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle><h2>Diagnostics</h2></CardTitle>
          <CardDescription>
            Save a support file with the app version, install paths, and upload, update, and launcher status.
            Credentials and export contents stay out of it.
          </CardDescription>
        </CardHeader>
        <CardFooter>
          <Button variant="outline" disabled={busy} onClick={() => void act(window.everlook.exportDiagnostics)}>
            <FileDownIcon data-icon="inline-start" />
            Export diagnostics
          </Button>
        </CardFooter>
      </Card>
      <SaveBar
        dirty={urlDirty}
        busy={busy || appState.authenticated}
        note="The URL is not saved yet."
        saveLabel="Save URL"
        onRevert={() => setBaseUrl(appState.settings.baseUrl)}
        onSave={() => void act(() => window.everlook.updateSettings({
          baseUrl,
          autoWatch: appState.settings.autoWatch
        }))}
      />
    </section>
  )
}
