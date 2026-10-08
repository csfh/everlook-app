#!/usr/bin/env bash

set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
project_root=$(cd -- "$script_dir/.." && pwd -P)
if [[ -n "${EVERLOOK_BUNDLE_ROOT:-}" ]]; then
  bundle_root=$EVERLOOK_BUNDLE_ROOT
elif [[ -f "$script_dir/everlook-launcher.sh" && ( -d "$script_dir/icons" || -f "$script_dir/Everlook.AppImage" ) ]]; then
  bundle_root=$script_dir
else
  bundle_root=
fi

data_home=${XDG_DATA_HOME:-"$HOME/.local/share"}
bin_home="$HOME/.local/bin"
app_dir="$data_home/everlook"
applications_dir="$data_home/applications"
icons_dir="$data_home/icons/hicolor"
app_path="$app_dir/Everlook.AppImage"
launcher_path="$bin_home/everlook"
desktop_path="$applications_dir/everlook.desktop"
desktop_temp=
installed_icon=

cleanup() {
  if [[ -n "$desktop_temp" ]]; then
    rm -f -- "$desktop_temp"
  fi
}
trap cleanup EXIT

desktop_exec_escape() {
  local value=$1
  value=${value//\\/\\\\}
  value=${value//\"/\\\"}
  value=${value//\`/\\\`}
  value=${value//\$/\\\$}
  value=${value//%/%%}
  printf '%s' "$value"
}

resolve_app_image() {
  if (($# > 0)); then
    printf '%s' "$1"
    return
  fi

  if [[ -n "$bundle_root" && -f "$bundle_root/Everlook.AppImage" ]]; then
    printf '%s' "$bundle_root/Everlook.AppImage"
    return
  fi

  local candidates=("$project_root"/dist/Everlook-*.AppImage)
  local candidate
  local newest=

  for candidate in "${candidates[@]}"; do
    [[ -f "$candidate" ]] || continue
    if [[ -z "$newest" || "$candidate" -nt "$newest" ]]; then
      newest=$candidate
    fi
  done

  if [[ -z "$newest" ]]; then
    printf 'No Everlook AppImage found under %s/dist. Run npm run package first.\n' "$project_root" >&2
    exit 1
  fi

  printf '%s' "$newest"
}

resolve_launcher() {
  if [[ -n "$bundle_root" && -f "$bundle_root/everlook-launcher.sh" ]]; then
    printf '%s' "$bundle_root/everlook-launcher.sh"
    return
  fi

  printf '%s' "$script_dir/everlook-launcher.sh"
}

icon_source_dir() {
  if [[ -n "$bundle_root" && -d "$bundle_root/icons" ]]; then
    printf '%s' "$bundle_root/icons"
    return
  fi

  printf '%s' "$project_root/build"
}

install_icons() {
  local source_dir
  source_dir=$(icon_source_dir)
  local size
  local source

  for size in 16 32 48 64 128 256 512; do
    source="$source_dir/icon-${size}.png"
    if [[ ! -f "$source" ]]; then
      continue
    fi
    mkdir -p -- "$icons_dir/${size}x${size}/apps"
    install -m 0644 -- "$source" "$icons_dir/${size}x${size}/apps/everlook.png"
    installed_icon=1
  done

  if [[ -f "$source_dir/icon.svg" ]]; then
    mkdir -p -- "$icons_dir/scalable/apps"
    install -m 0644 -- "$source_dir/icon.svg" "$icons_dir/scalable/apps/everlook.svg"
    installed_icon=1
  fi

  if [[ -z "$installed_icon" ]]; then
    printf 'No Everlook icons found under %s.\n' "$source_dir" >&2
    exit 1
  fi
}

source_app_image=$(resolve_app_image "$@")
if [[ ! -f "$source_app_image" ]]; then
  printf 'AppImage not found: %s\n' "$source_app_image" >&2
  exit 1
fi

source_launcher=$(resolve_launcher)
if [[ ! -f "$source_launcher" ]]; then
  printf 'Launcher not found: %s\n' "$source_launcher" >&2
  exit 1
fi

mkdir -p -- "$app_dir" "$bin_home" "$applications_dir"
install -m 0755 -- "$source_app_image" "$app_path"
install -m 0755 -- "$source_launcher" "$launcher_path"
install_icons

desktop_temp=$(mktemp --suffix=.desktop "$applications_dir/.everlook.XXXXXX")
escaped_launcher=$(desktop_exec_escape "$launcher_path")
cat >"$desktop_temp" <<EOF
[Desktop Entry]
Type=Application
Version=1.0
Name=Everlook
Comment=Secure desktop uploader for Everlook snapshots
Exec="$escaped_launcher" %u
TryExec=$launcher_path
Icon=everlook
Categories=Utility;
StartupWMClass=dev.csfh.everlook
StartupNotify=true
Terminal=false
MimeType=x-scheme-handler/everlook;
EOF

if command -v desktop-file-validate >/dev/null 2>&1; then
  desktop-file-validate "$desktop_temp"
fi
chmod 0644 "$desktop_temp"
mv -f -- "$desktop_temp" "$desktop_path"
desktop_temp=

if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$applications_dir" ||
    printf 'Warning: desktop database cache refresh failed.\n' >&2
fi
if command -v xdg-mime >/dev/null 2>&1; then
  xdg-mime default everlook.desktop x-scheme-handler/everlook ||
    printf 'Warning: everlook:// handler registration failed.\n' >&2
fi
if command -v gtk-update-icon-cache >/dev/null 2>&1; then
  gtk-update-icon-cache -f -t "$icons_dir" >/dev/null ||
    printf 'Warning: icon cache refresh failed.\n' >&2
fi

printf 'Installed Everlook. Open it from Super+Space or run %s.\n' "$launcher_path"
if command -v notify-send >/dev/null 2>&1; then
  notify-send --app-name=Everlook 'Everlook is installed' 'Open it from Super+Space or run everlook.' || true
fi
