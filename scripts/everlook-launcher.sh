#!/usr/bin/env bash

set -euo pipefail

data_home=${XDG_DATA_HOME:-"$HOME/.local/share"}
app_image="$data_home/everlook/Everlook.AppImage"

if [[ ! -x "$app_image" ]]; then
  printf 'Everlook is not installed at %s\n' "$app_image" >&2
  exit 1
fi

# Omarchy (and other fuse-less hosts) cannot mount AppImages. Extract in place.
export APPIMAGE_EXTRACT_AND_RUN=1
export ELECTRON_OZONE_PLATFORM_HINT="${ELECTRON_OZONE_PLATFORM_HINT:-auto}"

exec "$app_image" "$@"
