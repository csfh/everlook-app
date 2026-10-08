import { useState } from 'react'
import { CircleStopIcon, FolderSearchIcon, Gamepad2Icon } from 'lucide-react'
import type { AppState, WowLauncherSettings } from '../../../shared/types'
import { StatusDot } from '@/components/status-dot'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { wowLauncherActionLabel, wowLauncherCopy, type StatusTone } from '@/status'
import { Panel, SaveBar, Section, SwitchRow, TextField, ViewTitle } from '@/views/form-parts'

function wowTone(status: AppState['wow']['status']): StatusTone {
  if (status === 'running') return 'ok'
  if (status === 'error') return 'error'
  if (status === 'starting' || status === 'stopping') return 'busy'
  return 'idle'
}

export function LauncherView(props: {
  appState: AppState
  busy: boolean
  act: (operation: () => Promise<void>) => Promise<void>
  onWow: () => void
}) {
  if (props.appState.capabilities?.nativeBattleNet) return <NativeLauncherView {...props} />
  if (props.appState.capabilities && !props.appState.capabilities.managedWowLauncher) {
    return (
      <section>
        <ViewTitle
          id="launcher-heading"
          title="Launcher"
          description="Battle.net launching is unavailable on this platform."
        />
      </section>
    )
  }
  return <ManagedLauncherView {...props} />
}

function NativeLauncherView({
  appState,
  busy,
  act
}: {
  appState: AppState
  busy: boolean
  act: (operation: () => Promise<void>) => Promise<void>
}) {
  const selected = appState.nativeLauncherPath ?? appState.settings.nativeBattleNetPath ?? null

  return (
    <section className="flex flex-col gap-4" aria-labelledby="launcher-heading">
      <ViewTitle
        id="launcher-heading"
        title="Launcher"
        description="Open your installed Battle.net app, then launch WoW from Battle.net."
      />
      <Card>
        <CardHeader>
          <CardTitle>Battle.net</CardTitle>
          <CardDescription>Choose the Battle.net executable on Windows or its .app on macOS.</CardDescription>
        </CardHeader>
        <CardContent>
          {selected ? (
            <p className="break-all font-mono text-sm">{selected}</p>
          ) : (
            <p className="text-muted-foreground text-sm">No Battle.net launcher selected.</p>
          )}
          {appState.wow.error ? (
            <Alert variant="destructive" className="mt-3">
              <AlertTitle>Could not open Battle.net</AlertTitle>
              <AlertDescription>{appState.wow.error}</AlertDescription>
            </Alert>
          ) : null}
        </CardContent>
        <CardFooter className="flex flex-wrap gap-2">
          <Button variant="outline" disabled={busy} onClick={() => void act(window.everlook.chooseNativeLauncher)}>
            <FolderSearchIcon data-icon="inline-start" />
            Choose Battle.net
          </Button>
          <Button
            variant="gold"
            disabled={busy || selected === null}
            onClick={() => void act(window.everlook.openNativeLauncher)}
          >
            <Gamepad2Icon data-icon="inline-start" />
            Open Battle.net
          </Button>
        </CardFooter>
      </Card>
      <p className="text-muted-foreground text-sm">
        Everlook cannot determine whether WoW is running when you open Battle.net.
        Quit the game from WoW when you are finished.
      </p>
    </section>
  )
}

function ManagedLauncherView({
  appState,
  busy,
  act,
  onWow
}: {
  appState: AppState
  busy: boolean
  act: (operation: () => Promise<void>) => Promise<void>
  onWow: () => void
}) {
  const savedWowLauncher = appState.settings.wowLauncher
  const savedWowKey = JSON.stringify(savedWowLauncher)
  const [wowLauncher, setWowLauncher] = useState(savedWowLauncher)
  const [savedWowKeySeen, setSavedWowKeySeen] = useState(savedWowKey)
  if (savedWowKey !== savedWowKeySeen) {
    setSavedWowKeySeen(savedWowKey)
    setWowLauncher(savedWowLauncher)
  }
  const dirty = JSON.stringify(wowLauncher) !== savedWowKey
  const { wow } = appState
  const transitioning = wow.status === 'starting' || wow.status === 'stopping'

  function patch(update: Partial<WowLauncherSettings>): void {
    setWowLauncher((current) => ({ ...current, ...update }))
  }

  function whole(value: string): number {
    return Number(value)
  }

  return (
    <section className="flex flex-col gap-4" aria-labelledby="launcher-heading">
      <ViewTitle
        id="launcher-heading"
        title="Launcher"
        description="Starts Battle.net through gamescope and umu-run, using Launchers/wow.sh."
      />

      <Panel className="flex flex-wrap items-center gap-x-4 gap-y-3 px-4 py-3">
        <StatusDot tone={wowTone(wow.status)} className="size-2.5" />
        <p className="min-w-0 flex-1 basis-48 text-sm text-pretty" aria-live="polite">
          {wowLauncherCopy(wow)}
        </p>
        <Button
          variant={wow.status === 'running' ? 'outline' : 'gold'}
          disabled={busy || transitioning}
          onClick={onWow}
        >
          {transitioning ? (
            <Spinner data-icon="inline-start" />
          ) : wow.status === 'running' ? (
            <CircleStopIcon data-icon="inline-start" />
          ) : (
            <Gamepad2Icon data-icon="inline-start" />
          )}
          {wowLauncherActionLabel(wow)}
        </Button>
      </Panel>

      <Panel>
        <Section
          defaultOpen
          title="Programs"
          description="Where the launcher finds Wine, Battle.net, and Proton."
        >
          <TextField
            label="Wine prefix"
            value={wowLauncher.prefix}
            disabled={busy}
            onChange={(prefix) => patch({ prefix })}
          />
          <TextField
            label="Battle.net launcher"
            value={wowLauncher.battleNetLauncher}
            disabled={busy}
            onChange={(battleNetLauncher) => patch({ battleNetLauncher })}
          />
          <TextField
            label="Proton folder"
            value={wowLauncher.proton}
            disabled={busy}
            onChange={(proton) => patch({ proton })}
          />
          <div className="grid gap-3 min-[40rem]:grid-cols-2">
            <TextField
              label="Game ID"
              value={wowLauncher.gameId}
              hint="Passed to umu-run as GAMEID."
              disabled={busy}
              onChange={(gameId) => patch({ gameId })}
            />
            <TextField
              label="Store"
              value={wowLauncher.store}
              hint="Passed to umu-run as STORE."
              disabled={busy}
              onChange={(store) => patch({ store })}
            />
          </div>
        </Section>
        <Section
          title="Picture"
          description="gamescope draws the game at one size and scales it to your screen."
        >
          <div className="grid gap-3 min-[40rem]:grid-cols-2">
            <TextField
              label="Game width"
              type="number"
              min={1}
              value={wowLauncher.inputWidth}
              disabled={busy}
              onChange={(value) => patch({ inputWidth: whole(value) })}
            />
            <TextField
              label="Game height"
              type="number"
              min={1}
              value={wowLauncher.inputHeight}
              disabled={busy}
              onChange={(value) => patch({ inputHeight: whole(value) })}
            />
            <TextField
              label="Screen width"
              type="number"
              min={1}
              value={wowLauncher.outputWidth}
              disabled={busy}
              onChange={(value) => patch({ outputWidth: whole(value) })}
            />
            <TextField
              label="Screen height"
              type="number"
              min={1}
              value={wowLauncher.outputHeight}
              disabled={busy}
              onChange={(value) => patch({ outputHeight: whole(value) })}
            />
            <TextField
              label="Scaler"
              value={wowLauncher.scaler}
              hint="Passed as -S."
              disabled={busy}
              onChange={(scaler) => patch({ scaler })}
            />
            <TextField
              label="Refresh rate"
              type="number"
              min={1}
              placeholder="Automatic"
              value={wowLauncher.refreshRate ?? ''}
              hint="Leave empty to let gamescope choose."
              disabled={busy}
              onChange={(value) => patch({ refreshRate: value === '' ? null : Number(value) })}
            />
          </div>
          <SwitchRow
            id="wow-fullscreen"
            label="Fullscreen"
            description="gamescope takes over the display (-f)."
            checked={wowLauncher.fullscreen}
            disabled={busy}
            onCheckedChange={(fullscreen) => patch({ fullscreen })}
          />
          <SwitchRow
            id="wow-adaptive"
            label="Adaptive sync"
            description="Match the display's refresh rate to the game (--adaptive-sync)."
            checked={wowLauncher.adaptiveSync}
            disabled={busy}
            onCheckedChange={(adaptiveSync) => patch({ adaptiveSync })}
          />
        </Section>
        <Section title="Session" description="Extra options for how the game process starts.">
          <SwitchRow
            id="wow-rt"
            label="Realtime priority"
            description="Run gamescope at realtime priority (--rt)."
            checked={wowLauncher.realtime}
            disabled={busy}
            onCheckedChange={(realtime) => patch({ realtime })}
          />
          <SwitchRow
            id="wow-ldpreload"
            label="Clear LD_PRELOAD"
            description="Start gamescope with LD_PRELOAD unset (env -u LD_PRELOAD)."
            checked={wowLauncher.clearLdPreload}
            disabled={busy}
            onCheckedChange={(clearLdPreload) => patch({ clearLdPreload })}
          />
          <SwitchRow
            id="wow-gamemode"
            label="GameMode"
            description="Start umu-run through gamemoderun."
            checked={wowLauncher.gameMode}
            disabled={busy}
            onCheckedChange={(gameMode) => patch({ gameMode })}
          />
        </Section>
      </Panel>

      <SaveBar
        dirty={dirty}
        busy={busy}
        note="Saving rewrites Launchers/wow.sh."
        saveLabel="Save launcher"
        onRevert={() => setWowLauncher(savedWowLauncher)}
        onSave={() =>
          void act(() =>
            window.everlook.updateSettings({
              baseUrl: appState.settings.baseUrl,
              autoWatch: appState.settings.autoWatch,
              wowLauncher
            })
          )
        }
      />
    </section>
  )
}
