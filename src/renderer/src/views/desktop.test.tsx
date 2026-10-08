import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { AppState, InstallationState } from '../../../shared/types'
import { AddonsView } from './addons'
import { LauncherView } from './launcher'
import { SettingsView } from './settings'
import { UploadsView } from './uploads'
import { UpdateSettings } from '../update-panel'
import { TitleBar } from '../components/title-bar'
import { Tabs } from '../components/ui/tabs'
import { TooltipProvider } from '../components/ui/tooltip'
import { SetupView } from './setup'

const installation = (addonsPath: string): InstallationState => ({
  status: 'missing', addonsPath, version: null, publishedVersion: '0.5.0', title: 'Everlook', interface: null, error: null,
  signing: { status: 'not_placed', fingerprint: null, placedPath: null, error: null }, files: []
})
const state: AppState = {
  authenticated: true, credentialStorage: 'os-keyring',
  settings: { baseUrl: 'https://everlook.csfh.dev', autoWatch: true, closeToTray: false, selectedFiles: [], uploads: {}, wowLauncher: {
    prefix: '/wine', battleNetLauncher: '/battle.net', proton: '/proton', gameId: 'wow', store: 'battlenet',
    inputWidth: 1920, inputHeight: 1080, outputWidth: 1920, outputHeight: 1080, scaler: 'fit', refreshRate: null,
    fullscreen: true, adaptiveSync: false, realtime: false, clearLdPreload: false, gameMode: false
  } },
  files: [], update: { status: 'idle', currentVersion: '0.5.0', availableVersion: null, downloadPercent: null, error: null },
  addon: installation('/wow/Interface/AddOns'), signing: installation('/wow/Interface/AddOns').signing,
  wow: { status: 'idle', scriptPath: null, error: null }
}
const act = async (operation: () => Promise<void>) => operation()
const capabilities = { platform: 'win32', arch: 'x64', managedWowLauncher: false, nativeBattleNet: true, loginStartup: true, automaticUpdates: true }

describe('desktop renderer integration', () => {
  it('shows each installation and its own signing/export state before the first export', () => {
    const installs = [installation('/wow-one/Interface/AddOns'), installation('/wow-two/Interface/AddOns')]
    const html = renderToStaticMarkup(<AddonsView appState={{ ...state, installations: installs }} busy={false} act={act} />)
    expect(html).toContain('/wow-one/Interface/AddOns')
    expect(html).toContain('/wow-two/Interface/AddOns')
    expect(html).toContain('Install Everlook in /wow-one/Interface/AddOns')
    expect(html).toContain('Place signing token in /wow-two/Interface/AddOns')
    expect(html).toContain('No export yet')
  })

  it('hides Wine/gamescope/Stop controls on native platforms', () => {
    const html = renderToStaticMarkup(<LauncherView appState={{ ...state, capabilities, nativeLauncherPath: 'C:\\Battle.net.exe', wow: { ...state.wow, status: 'running' } }} busy={false} act={act} onWow={() => {}} />)
    expect(html).toContain('Open Battle.net')
    expect(html).toContain('Choose Battle.net')
    expect(html).not.toMatch(/Wine prefix|gamescope|Proton folder|Stop WoW|wow\.sh/)
  })

  it('preserves managed launcher controls when legacy state has no capabilities', () => {
    const html = renderToStaticMarkup(<LauncherView appState={state} busy={false} act={act} onWow={() => {}} />)
    expect(html).toContain('Wine prefix')
    expect(html).toContain('gamescope')
  })

  it('offers a manual download for an available update without claiming it was downloaded', () => {
    const html = renderToStaticMarkup(<UpdateSettings update={{ ...state.update, mode: 'manual', status: 'available', availableVersion: '0.6.0', downloadUrl: 'https://example.com/app.dmg' }} uploading={true} busy={false} act={act} />)
    expect(html).toContain('Download update')
    expect(html).not.toMatch(/Downloading|Install and restart/)
  })

  it('shows pending retry and history even when no files are currently watched', () => {
    const html = renderToStaticMarkup(<UploadsView appState={{ ...state, pending: [{ path: '/wow/Everlook.lua', scope: 'account', revision: '1', force: false, queuedAt: '2026-10-03T00:00:00Z', status: 'retrying', attempts: 2, nextAttemptAt: '2026-10-03T00:01:00Z', error: 'Network unavailable', setupUrl: null }], history: [{ id: 'attempt1', path: '/wow/Everlook.lua', scope: 'account', at: '2026-10-03T00:00:00Z', outcome: 'uploaded', hash: null, uploadId: 9, ingestStatus: 'failed', signed: null, error: null }] }} busy={false} act={act} />)
    expect(html).toContain('Waiting to retry')
    expect(html).toContain('Retry now')
    expect(html).toContain('Uploaded to Everlook')
    expect(html).toContain('Ingest failed')
    expect(html).toContain('server processes')
    expect(html).not.toContain('Open security settings')
  })

  it('offers security settings when an upload is waiting on the account', () => {
    const html = renderToStaticMarkup(<UploadsView appState={{ ...state, pending: [{ path: '/wow/Everlook.lua', scope: 'account', revision: '1', force: false, queuedAt: '2026-10-03T00:00:00Z', status: 'security-required', attempts: 1, nextAttemptAt: null, error: 'Finish securing your account on everlook.ing to resume uploads.', setupUrl: 'https://everlook.ing/account/security' }] }} busy={false} act={act} />)
    expect(html).toContain('Secure account to resume')
    expect(html).toContain('Open security settings')
    expect(html).toContain('Finish securing your account on everlook.ing to resume uploads.')
  })

  it('shows a revoked contribution without a sign-in or security action', () => {
    const html = renderToStaticMarkup(<UploadsView appState={{ ...state, pending: [{ path: '/wow/Everlook.lua', scope: 'account', revision: '1', force: false, queuedAt: '2026-10-03T00:00:00Z', status: 'contributions-revoked', attempts: 1, nextAttemptAt: null, error: 'Contributions from this account were revoked.', setupUrl: null }] }} busy={false} act={act} />)
    expect(html).toContain('Contributions revoked')
    expect(html).toContain('Contributions from this account were revoked.')
    expect(html).not.toContain('Sign in to resume')
    expect(html).not.toContain('Open security settings')
    expect(html).not.toContain('Retry now')
  })

  it('shows disabled opt-ins, diagnostics, and account verification errors', () => {
    const html = renderToStaticMarkup(<SettingsView appState={{ ...state, capabilities, startup: { supported: true, enabled: false, error: null }, accountError: 'Could not verify your account' }} baseUrl={state.settings.baseUrl} setBaseUrl={() => {}} busy={false} uploading={false} act={act} />)
    expect(html).toContain('Start at login')
    expect(html).toContain('Notify when an upload fails')
    expect(html).toContain('Notify when an update is ready')
    expect(html).toContain('Export diagnostics')
    expect(html).toContain('Could not verify your account')
    expect(html).not.toContain('aria-checked="true" id="start-at-login"')
  })

  it('leaves space for Mac traffic lights and hides custom window controls', () => {
    const html = renderToStaticMarkup(<TooltipProvider><Tabs><TitleBar authenticated={true} busy={false} wow={state.wow} capabilities={{ ...capabilities, platform: 'darwin' }} onWow={() => {}} /></Tabs></TooltipProvider>)
    expect(html).not.toMatch(/aria-label="Close"|aria-label="Minimize"|aria-label="Maximize"/)
    expect(html).toContain('pl-20')
    expect(html).toContain('Setup')
    expect(html).not.toContain('Launch WoW')
  })

  it('offers sign-in again instead of claiming a failed account verification is connected', () => {
    const html = renderToStaticMarkup(<SetupView appState={{ ...state, accountError: 'Verification offline' }} baseUrl={state.settings.baseUrl} setBaseUrl={() => {}} busy={false} act={act} onUploads={() => {}} />)
    expect(html).toContain('Verification offline')
    expect(html).toContain('Sign in again')
    expect(html).not.toContain('>Connected<')
  })

  it('keeps unsigned exports waiting and explains how to place the token and save again', () => {
    const install = { ...installation('/wow/Interface/AddOns'), status: 'current' as const, files: ['/wow/Everlook.lua'] }
    const html = renderToStaticMarkup(<SetupView appState={{ ...state, installations: [install], history: [{ id: 'unsigned', path: '/wow/Everlook.lua', scope: 'account', at: '2026-10-03T00:00:00Z', outcome: 'uploaded', hash: null, uploadId: 9, ingestStatus: 'completed', signed: 'unsigned', error: null }] }} baseUrl={state.settings.baseUrl} setBaseUrl={() => {}} busy={false} act={act} onUploads={() => {}} />)
    expect(html).toContain('Waiting for a signed export')
    expect(html).toContain('Place token and save again')
    expect(html).not.toContain('Setup complete')
  })

  it('shows a processing failure with a placed token without asking to place it again', () => {
    const install = { ...installation('/wow/Interface/AddOns'), status: 'current' as const, signing: { ...state.signing, status: 'placed' as const }, files: ['/wow/Everlook.lua'] }
    const html = renderToStaticMarkup(<SetupView appState={{ ...state, installations: [install], history: [{ id: 'failed', path: '/wow/Everlook.lua', scope: 'account', at: '2026-10-04T00:00:00Z', outcome: 'uploaded', hash: null, uploadId: 67, ingestStatus: 'failed', signed: null, error: 'This world file could not be processed. Try uploading it again.' }] }} baseUrl={state.settings.baseUrl} setBaseUrl={() => {}} busy={false} act={act} onUploads={() => {}} />)
    expect(html).toContain('Everlook is installed and its signing token is placed.')
    expect(html).toContain('Server processing needs attention')
    expect(html).toContain('This world file could not be processed. Try uploading it again.')
    expect(html).not.toContain('Waiting for a signed export')
    expect(html).not.toContain('Place token and save again')
    expect(html).not.toContain('Waiting for signature verification and server processing.')
  })

  it('requires both the server signature and ingest completion for the latest export', () => {
    const install = { ...installation('/wow/Interface/AddOns'), status: 'current' as const, files: ['/wow/Everlook.lua'] }
    const historyEntry = { id: 'signed', path: '/wow/Everlook.lua', scope: 'account', at: '2026-10-03T00:00:00Z', outcome: 'uploaded' as const, hash: null, uploadId: 9, ingestStatus: 'pending', signed: 'signed' as const, error: null }
    const history = [historyEntry]
    const render = (appState: AppState) => renderToStaticMarkup(<SetupView appState={appState} baseUrl={state.settings.baseUrl} setBaseUrl={() => {}} busy={false} act={act} onUploads={() => {}} />)
    expect(render({ ...state, installations: [install], history })).toContain('Waiting for server processing')
    const done = render({ ...state, authenticated: true, installations: [install], history: history.map((entry) => ({ ...entry, ingestStatus: 'completed' })) })
    expect(done).toContain('Step 1, done:')
    expect(done).toContain('Step 2, done:')
    expect(done).toContain('Step 4, done:')
    const fresh = render({ ...state, authenticated: false, installations: [] })
    expect(fresh).toContain('Step 1:')
    expect(fresh).not.toContain('done:')
    expect(render({ ...state, installations: [install], history: history.map((entry) => ({ ...entry, ingestStatus: 'completed' })) })).toContain('Setup complete')
    expect(render({ ...state, installations: [install], history: [...history, { ...historyEntry, id: 'old', at: '2026-10-02T00:00:00Z', ingestStatus: 'completed' }] })).not.toContain('Setup complete')
  })

  it('collapses finished setup steps behind a summary and keeps unfinished ones open', () => {
    const install = { ...installation('/wow/Interface/AddOns'), status: 'current' as const, signing: { ...state.signing, status: 'placed' as const } }
    const html = renderToStaticMarkup(<SetupView appState={{ ...state, installations: [install] }} baseUrl={state.settings.baseUrl} setBaseUrl={() => {}} busy={false} act={act} onUploads={() => {}} />)
    expect(html.match(/aria-expanded="false"/g)).toHaveLength(3)
    expect(html.match(/aria-expanded="true"/g)).toHaveLength(1)
    expect(html.match(/Step \d, done:/g)).toHaveLength(3)
    expect(html).toContain('Signed in to https://everlook.csfh.dev.')
    expect(html).toContain('1 installation found.')
    expect(html).toContain('Everlook is installed and its signing token is placed.')
    expect(html).not.toContain('Your password stays in the browser.')
    expect(html).not.toContain('Install Everlook in /wow/Interface/AddOns')
    expect(html).toContain('Waiting for the first Everlook.lua export.')
  })

  it('uses accessible labels for controls and disables default notification opt-ins', () => {
    const html = renderToStaticMarkup(<SettingsView appState={{ ...state, capabilities, startup: { supported: true, enabled: false, error: null } }} baseUrl={state.settings.baseUrl} setBaseUrl={() => {}} busy={false} uploading={false} act={act} />)
    for (const id of ['start-at-login', 'notify-upload-failures', 'notify-updates']) {
      expect(html).toContain(`for="${id}"`)
      const switchElement = html.match(new RegExp(`<button[^>]*id="${id}"[^>]*>`))?.[0]
      expect(switchElement).toContain('role="switch"')
      expect(switchElement).toContain('aria-checked="false"')
      expect(switchElement).toContain(`aria-describedby="${id}-description"`)
      expect(html).toContain(`id="${id}-description"`)
    }
    const setup = renderToStaticMarkup(<SetupView appState={{ ...state, authenticated: false, installations: [] }} baseUrl={state.settings.baseUrl} setBaseUrl={() => {}} busy={false} act={act} onUploads={() => {}} />)
    expect(setup).toContain('aria-labelledby="setup-heading"')
    expect(setup).toContain('>Choose WoW root</button>')
    expect(setup).toContain('Sign in')
    expect(setup).toContain('Create the first export')
  })

  it('names an update by what failed and shows the pending reason on the export', () => {
    const updateHtml = renderToStaticMarkup(<UpdateSettings update={{ ...state.update, status: 'error', availableVersion: '0.6.0', error: 'Could not reach the update feed: offline' }} uploading={false} busy={false} act={act} />)
    expect(updateHtml).toContain('Version 0.6.0 could not be downloaded.')
    expect(updateHtml).toContain('Could not reach the update feed: offline')
    const file = {
      path: '/wow/Everlook.lua', account: 'ACCOUNT1', lastDetectedAt: null, lastUploadedAt: null, lastUploadedHash: null,
      status: 'error' as const, error: 'Upload could not finish. See pending uploads for retry details.', response: null, signed: null
    }
    const uploads = renderToStaticMarkup(<TooltipProvider><UploadsView appState={{ ...state, files: [file], pending: [{ path: file.path, scope: 'account', revision: '1', force: false, queuedAt: '2026-10-03T00:00:00Z', status: 'retrying', attempts: 1, nextAttemptAt: null, error: 'Everlook could not be reached. Waiting to retry.', setupUrl: null }] }} busy={false} act={act} /></TooltipProvider>)
    expect(uploads).toContain('Everlook could not be reached. Waiting to retry.')
    expect(uploads).toContain('Upload export for ACCOUNT1')
    expect(uploads).not.toContain('See pending uploads for retry details.')
  })

  it('keeps launcher status available when the title bar hides it', () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <Tabs>
          <TitleBar authenticated={true} busy={false} wow={{ status: 'error', scriptPath: null, error: 'Proton Experimental not found.' }} capabilities={{ ...capabilities, platform: 'linux', managedWowLauncher: true, nativeBattleNet: false }} onWow={() => {}} />
        </Tabs>
      </TooltipProvider>
    )
    expect(html).toContain('sr-only min-[60rem]:hidden')
    expect(html).toContain('Proton Experimental not found.')
  })

  it('labels an addon update differently from a first install', () => {
    const behind = { ...installation('/wow/Interface/AddOns'), status: 'behind' as const, version: '0.4.0' }
    const html = renderToStaticMarkup(<AddonsView appState={{ ...state, installations: [behind] }} busy={false} act={act} />)
    expect(html).toContain('Update Everlook in /wow/Interface/AddOns')
    expect(html).not.toContain('Install Everlook in /wow/Interface/AddOns')
  })

  it('describes manual Mac notifications as available DMGs and explains native close behavior', () => {
    const html = renderToStaticMarkup(<SettingsView appState={{ ...state, capabilities: { ...capabilities, platform: 'darwin' }, update: { ...state.update, mode: 'manual' } }} baseUrl={state.settings.baseUrl} setBaseUrl={() => {}} busy={false} uploading={false} act={act} />)
    expect(html).toContain('Notify when an update is available')
    expect(html).toContain('macOS DMG is available to download')
    expect(html).toContain('macOS keeps Everlook running after its window closes')
    expect(html).not.toContain('downloaded update can be installed')
  })
})
