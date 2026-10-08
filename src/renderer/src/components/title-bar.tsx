import { useEffect, useState, type ReactNode } from 'react'
import {
  CircleStopIcon,
  Gamepad2Icon,
  Minimize2Icon,
  MinusIcon,
  PuzzleIcon,
  RocketIcon,
  SettingsIcon,
  ListChecksIcon,
  SquareIcon,
  UploadIcon,
  XIcon
} from 'lucide-react'
import { cn } from 'cn'
import type { PlatformCapabilities, WowLauncherState } from '../../../shared/types'
import { AppLogoIcon } from '@/components/app-logo-icon'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { wowLauncherActionLabel, wowLauncherCopy } from '@/status'

const views = [
  { value: 'setup', label: 'Setup', Icon: ListChecksIcon },
  { value: 'uploads', label: 'Uploads', Icon: UploadIcon },
  { value: 'launcher', label: 'Launcher', Icon: RocketIcon },
  { value: 'addons', label: 'Addons', Icon: PuzzleIcon },
  { value: 'settings', label: 'Settings', Icon: SettingsIcon }
] as const

export function TitleBar({
  authenticated,
  busy,
  wow,
  capabilities,
  update,
  onWow
}: {
  authenticated: boolean
  busy: boolean
  wow: WowLauncherState | null
  capabilities?: PlatformCapabilities
  update?: ReactNode
  onWow: () => void
}) {
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    void window.everlook.isWindowMaximized().then(setMaximized)
    return window.everlook.onWindowMaximized(setMaximized)
  }, [])

  const native = capabilities?.nativeBattleNet ?? false
  const managed = capabilities?.managedWowLauncher ?? true
  const mac = capabilities?.platform === 'darwin' || (
    capabilities === undefined && typeof navigator !== 'undefined' && /Macintosh|Mac OS X/.test(navigator.userAgent)
  )
  const session = !managed || wow === null || wow.status === 'idle' ? null : wowLauncherCopy(wow)
  const failed = wow?.status === 'error'

  return (
    <header
      className="app-drag flex h-12 shrink-0 items-stretch border-b bg-background select-none"
      onDoubleClick={(event) => {
        if (event.target instanceof Element && event.target.closest('.app-no-drag')) return
        void window.everlook.maximizeWindow()
      }}
    >
      <div className={cn('flex shrink-0 items-center gap-2.5 pr-4', mac ? 'pl-20' : 'pl-4')}>
        <AppLogoIcon className="size-7 shrink-0" />
        <p className="font-display text-base leading-none font-semibold">Everlook</p>
      </div>
      {wow !== null ? (
        <TabsList variant="line" aria-label="Everlook" className="app-no-drag gap-0 p-0 group-data-horizontal/tabs:h-full">
          {views.filter(({ value }) => authenticated || value === 'setup' || value === 'settings').map(({ value, label, Icon }) => (
            <TabsTrigger
              key={value}
              value={value}
              className="h-full flex-none gap-2 rounded-none px-3 after:bottom-0 after:bg-hero-gold"
            >
              <Icon aria-hidden="true" />
              <span className="max-[52rem]:sr-only">{label}</span>
            </TabsTrigger>
          ))}
        </TabsList>
      ) : null}
      <div className="flex min-w-0 flex-1 items-center justify-end gap-3 px-3">
        {session ? (
          <>
            <p className="sr-only min-[60rem]:hidden" aria-live="polite">{session}</p>
            <p
              key={session}
              className={cn(
                'titlebar-status hidden min-w-0 truncate text-xs min-[60rem]:block',
                failed ? 'text-destructive' : 'text-muted-foreground'
              )}
              aria-live="polite"
            >
              {session}
            </p>
          </>
        ) : null}
        {update}
        {wow && managed ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                className="app-no-drag"
                variant={failed ? 'destructive' : wow.status === 'running' ? 'outline' : 'default'}
                disabled={busy || wow.status === 'starting' || wow.status === 'stopping'}
                aria-label={wowLauncherActionLabel(wow)}
                onClick={onWow}
              >
                {wow.status === 'starting' || wow.status === 'stopping' ? (
                  <Spinner data-icon="inline-start" />
                ) : wow.status === 'running' ? (
                  <CircleStopIcon data-icon="inline-start" />
                ) : (
                  <Gamepad2Icon data-icon="inline-start" />
                )}
                {wowLauncherActionLabel(wow)}
              </Button>
            </TooltipTrigger>
            <TooltipContent sideOffset={6}>{wowLauncherCopy(wow)}</TooltipContent>
          </Tooltip>
        ) : null}
        {wow && native ? (
          <Button className="app-no-drag" variant="outline" disabled={busy} onClick={onWow}>
            <Gamepad2Icon data-icon="inline-start" />
            Open Battle.net
          </Button>
        ) : null}
      </div>
      {!mac ? (
        <div className="app-no-drag flex items-stretch border-l">
          <WindowControl label="Minimize" onClick={() => void window.everlook.minimizeWindow()}>
            <MinusIcon />
          </WindowControl>
          <WindowControl
            label={maximized ? 'Restore' : 'Maximize'}
            onClick={() => void window.everlook.maximizeWindow()}
          >
            {maximized ? <Minimize2Icon /> : <SquareIcon />}
          </WindowControl>
          <WindowControl label="Close" tone="close" onClick={() => void window.everlook.closeWindow()}>
            <XIcon />
          </WindowControl>
        </div>
      ) : null}
    </header>
  )
}

function WindowControl({
  label,
  tone = 'default',
  onClick,
  children
}: {
  label: string
  tone?: 'default' | 'close'
  onClick: () => void
  children: ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          className={cn(
            'inline-flex h-full w-10 items-center justify-center text-foreground transition-[transform,opacity] duration-150 ease-out hover:bg-muted focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset active:opacity-80 [&_svg]:size-4',
            tone === 'close' && 'hover:bg-destructive hover:text-white'
          )}
          onClick={onClick}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent sideOffset={6}>{label}</TooltipContent>
    </Tooltip>
  )
}
