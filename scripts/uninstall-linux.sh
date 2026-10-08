#!/usr/bin/env bash

set -euo pipefail

data_home=${XDG_DATA_HOME:-"$HOME/.local/share"}
bin_home="$HOME/.local/bin"
app_dir="$data_home/everlook"
applications_dir="$data_home/applications"
icons_dir="$data_home/icons/hicolor"

rm -f -- "$app_dir/Everlook.AppImage"
rm -f -- "$bin_home/everlook"
rm -f -- "$applications_dir/everlook.desktop"

for size in 16 32 48 64 128 256 512; do
  icon_target_dir="$icons_dir/${size}x${size}/apps"
  rm -f -- "$icon_target_dir/everlook.png"
  rmdir --ignore-fail-on-non-empty "$icon_target_dir" 2>/dev/null || true
done

scalable_icon_dir="$icons_dir/scalable/apps"
rm -f -- "$scalable_icon_dir/everlook.svg"
rmdir --ignore-fail-on-non-empty "$scalable_icon_dir" 2>/dev/null || true
rmdir --ignore-fail-on-non-empty "$app_dir" 2>/dev/null || true

if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$applications_dir" ||
    printf 'Warning: desktop database cache refresh failed.\n' >&2
fi
if [[ -d "$icons_dir" ]] && command -v gtk-update-icon-cache >/dev/null 2>&1; then
  gtk-update-icon-cache -f -t "$icons_dir" >/dev/null ||
    printf 'Warning: icon cache refresh failed.\n' >&2
fi

printf 'Uninstalled Everlook desktop integration.\n'
