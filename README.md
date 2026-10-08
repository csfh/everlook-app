# Everlook

Desktop companion for [Everlook](https://everlook.ing). It finds the Everlook addon's exports, uploads them, and keeps the addon installed and signed.

## Develop

```sh
npm ci
npm test
npm run test:desktop
npm run test:release
npm run lint
npm run build
npm run dev
```

Linux desktop integration tests run on Linux. Unit tests, lint, and builds run on Windows and both Mac architectures in CI too.

## Setup and uploads

Open **Setup** to sign in through the browser and choose the World of Warcraft root or a flavor folder. You can choose an installation before its first export exists. Each installation has its own addon and signing-token actions. Development checkouts stay protected: token placement works only when `sign.lua` is ignored and untracked, and the desktop app preserves symlinked addons.

Enable Everlook in WoW, then log out or use `/reload` to save the export. The app discovers exports in selected and standard installation locations while it is running. Setup shows when Everlook has received a signed export and completed ingest.

Uploads keeps one pending entry for the latest contents of each file. Restarting the app resumes those entries after account verification. A file changed during upload stays queued for another send. Account and site identity scope the queue, history, and saved hashes; a different account cannot send the previous account's pending entries. Earlier shared hashes stay unattributed when settings migrate.

Transient failures retry with backoff and respect `Retry-After`. Authentication failures pause uploads until sign-in succeeds. Missing files and permanent errors stay visible with a retry action. Removing a watched file also removes its pending work. History retains the latest 200 outcomes per account and site, with transfer, signature, and ingest status shown separately.

**Start at login**, desktop notifications, and **Keep running in the tray** are off by default. Startup uses Electron login items on Windows/Mac and an XDG autostart entry on Linux. On Linux, enable a tray host before hiding the window. Running Everlook again brings it back. Mac windows can close and reopen while watchers keep running until you quit the app.

Windows and Mac open the native Battle.net launcher. Linux keeps the gamescope/Proton launcher and its Stop control. Native Battle.net sessions are managed by Battle.net.

**Export diagnostics** saves app and installation metadata with upload counts and redacted errors. It excludes credentials, signing secrets, export contents, and HTTP response bodies. Home and WoW account paths are redacted.

Login tokens use Electron `safeStorage` when a keyring is available. Otherwise Everlook saves a user-only `0600` file, or keeps the token for the current session if disk storage fails. The app shows the storage mode in Settings.

## Package and release

```sh
npm run package
```

Packaging uses the current host platform. The release workflow builds Linux x64 (AppImage, deb, Omarchy zip), Windows x64 (NSIS), and separate Mac Intel/Apple Silicon DMGs. Windows and Mac builds are unsigned, and Mac builds are not notarized. On Mac, choose the DMG for your chip and approve the downloaded app in System Settings → Privacy & Security when macOS asks. [Apple's download guidance](https://support.apple.com/en-us/102445) describes this flow.

Push conventional commits to `main` to release. The workflow runs all native tests, prepares one version, and shares the prepared package manifests with every build. It verifies packaged renderer/preload startup and IPC on each platform. Windows CI installs an older fixture and checks its update to the prepared version, including protocol registration. A manual workflow dispatch produces preview artifacts without publishing or changing Git history.

Publication waits for all four builds and validates required files, hashes, and updater feed checksums. Missing storage credentials fail the job. Binaries upload before feed metadata, and `desktop-release.json` uploads last. One version commit, tag, and GitHub release follow. The manifest and files live at the root of the app bucket. The website serves downloads at `/download/{artifact}` and feeds at `/updates/{filename}`.

Required repository secrets are `APP_AWS_ACCESS_KEY_ID`, `APP_AWS_SECRET_ACCESS_KEY`, `APP_AWS_BUCKET`, `AWS_ENDPOINT`, and `AWS_DEFAULT_REGION`; `AWS_USE_PATH_STYLE_ENDPOINT` is available for S3-compatible storage. These are the existing app disk credentials. Signing credentials are not required.

AppImage and Windows NSIS builds download updates in the background. Settings offers **Install and restart** after the download finishes and blocks a restart during an upload. Mac checks the public manifest and offers a DMG download for its architecture. Quit Everlook and replace the app in Applications to install it. Development and deb builds do not automatically check an unsupported updater feed.

For Omarchy, unzip the release and run `./install.sh`. The installer puts the AppImage in `~/.local/share/everlook`, adds a wrapper in `~/.local/bin/everlook`, and registers the desktop entry. The wrapper sets `APPIMAGE_EXTRACT_AND_RUN` and `ELECTRON_OZONE_PLATFORM_HINT`.

The app talks to the Everlook website. A release that needs a new website endpoint ships after the site has it: `GET /api/desktop/me`, extended upload status, `/download/desktop.json`, and the Windows updater routes.

## License

MIT. See [LICENSE](LICENSE). Copyright (c) 2026 Christoffer Hallas.

If you send a pull request or other contribution, you agree to the [CLA](CLA.md).
