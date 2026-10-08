#!/usr/bin/env bash

set -euo pipefail

project_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
test_root=$(mktemp -d --tmpdir everlook-desktop-test.XXXXXX)
trap 'rm -rf -- "$test_root"' EXIT

export HOME="$test_root/home with spaces"
export XDG_DATA_HOME="$HOME/local data"
export TEST_LOG="$test_root/launch.log"
unset ELECTRON_OZONE_PLATFORM_HINT
fake_bin="$test_root/fake-bin"
fake_app_image="$test_root/Everlook test.AppImage"
xdg_mime_log="$test_root/xdg-mime.log"

mkdir -p -- "$HOME" "$fake_bin"
cat >"$fake_bin/xdg-mime" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"${XDG_MIME_LOG:?}"
EOF
chmod 0755 "$fake_bin/xdg-mime"
export PATH="$fake_bin:$PATH"
export XDG_MIME_LOG="$xdg_mime_log"
cat >"$fake_app_image" <<'EOF'
#!/usr/bin/env bash
printf 'extract=%s\n' "${APPIMAGE_EXTRACT_AND_RUN-<unset>}" >"$TEST_LOG"
printf 'ozone=%s\n' "${ELECTRON_OZONE_PLATFORM_HINT-<unset>}" >>"$TEST_LOG"
printf 'arg=%s\n' "$@" >>"$TEST_LOG"
EOF
chmod 0755 "$fake_app_image"

bash "$project_root/scripts/install-linux.sh" "$fake_app_image"
bash "$project_root/scripts/install-linux.sh" "$fake_app_image"

app_path="$XDG_DATA_HOME/everlook/Everlook.AppImage"
launcher_path="$HOME/.local/bin/everlook"
desktop_path="$XDG_DATA_HOME/applications/everlook.desktop"

[[ -x "$app_path" ]]
[[ -x "$launcher_path" ]]
[[ -f "$desktop_path" ]]
[[ -f "$XDG_DATA_HOME/icons/hicolor/scalable/apps/everlook.svg" ]]
grep -Fqx 'Name=Everlook' "$desktop_path"
grep -Fqx "Exec=\"$launcher_path\" %u" "$desktop_path"
grep -Fqx "TryExec=$launcher_path" "$desktop_path"
if grep -q '^Exec=env ' "$desktop_path"; then
  printf 'Desktop Exec must call the wrapper; env VAR= is not portable.\n' >&2
  exit 1
fi
grep -Fqx 'MimeType=x-scheme-handler/everlook;' "$desktop_path"
grep -Fqx 'StartupWMClass=dev.csfh.everlook' "$desktop_path"
grep -Fqx 'default everlook.desktop x-scheme-handler/everlook' "$xdg_mime_log"
grep -Fqx 'export APPIMAGE_EXTRACT_AND_RUN=1' "$launcher_path"
grep -Fqx 'export ELECTRON_OZONE_PLATFORM_HINT="${ELECTRON_OZONE_PLATFORM_HINT:-auto}"' "$launcher_path"

protocol_url='everlook://auth/callback?code=hello world&state=one'
"$launcher_path" "$protocol_url"
grep -Fqx 'extract=1' "$TEST_LOG"
grep -Fqx 'ozone=auto' "$TEST_LOG"
grep -Fqx "arg=$protocol_url" "$TEST_LOG"

ELECTRON_OZONE_PLATFORM_HINT=wayland "$launcher_path" --version
grep -Fqx 'extract=1' "$TEST_LOG"
grep -Fqx 'ozone=wayland' "$TEST_LOG"
grep -Fqx 'arg=--version' "$TEST_LOG"

bash "$project_root/scripts/uninstall-linux.sh"
[[ ! -e "$app_path" ]]
[[ ! -e "$launcher_path" ]]
[[ ! -e "$desktop_path" ]]
[[ ! -e "$XDG_DATA_HOME/icons/hicolor/scalable/apps/everlook.svg" ]]

printf 'Linux desktop integration smoke test passed.\n'
