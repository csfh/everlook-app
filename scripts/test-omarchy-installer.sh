#!/usr/bin/env bash

set -euo pipefail

project_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
test_root=$(mktemp -d --tmpdir everlook-omarchy-test.XXXXXX)
trap 'rm -rf -- "$test_root"' EXIT

export HOME="$test_root/home with spaces"
export XDG_DATA_HOME="$HOME/local data"
export TEST_LOG="$test_root/launch.log"
unset ELECTRON_OZONE_PLATFORM_HINT
fake_app_image="$test_root/Everlook.AppImage"
archive="$test_root/Everlook-0.1.0-omarchy.zip"
extract="$test_root/extract"

cat >"$fake_app_image" <<'EOF'
#!/usr/bin/env bash
printf 'extract=%s\n' "${APPIMAGE_EXTRACT_AND_RUN-<unset>}" >"$TEST_LOG"
printf 'ozone=%s\n' "${ELECTRON_OZONE_PLATFORM_HINT-<unset>}" >>"$TEST_LOG"
printf 'arg=%s\n' "$@" >>"$TEST_LOG"
EOF
chmod 0755 "$fake_app_image"

ZEPPELIN_APPIMAGE="$fake_app_image" \
  ZEPPELIN_VERSION=0.1.0 \
  ZEPPELIN_OMARCHY_OUTPUT="$archive" \
  bash "$project_root/scripts/package-omarchy.sh"

[[ -f "$archive" ]]
# Read the listing first. With pipefail, `grep -q` quits at its first match and
# `unzip` can take a SIGPIPE (exit 141) at random.
listing=$(unzip -l "$archive")
grep -Fq 'install.sh' <<<"$listing"
grep -Fq 'Everlook.AppImage' <<<"$listing"
grep -Fq 'README.md' <<<"$listing"
readme=$(unzip -p "$archive" README.md)
grep -Fq 'unzip && ./install.sh' <<<"$readme"

mkdir -p -- "$extract"
unzip -d "$extract" "$archive"
[[ -x "$extract/install.sh" ]]
[[ -x "$extract/Everlook.AppImage" ]]
[[ -x "$extract/everlook-launcher.sh" ]]

"$extract/install.sh"

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
grep -Fqx 'StartupWMClass=dev.csfh.everlook' "$desktop_path"
grep -Fqx 'MimeType=x-scheme-handler/everlook;' "$desktop_path"

"$launcher_path" --installed
grep -Fqx 'extract=1' "$TEST_LOG"
grep -Fqx 'ozone=auto' "$TEST_LOG"
grep -Fqx 'arg=--installed' "$TEST_LOG"

printf 'Omarchy installer smoke test passed.\n'
