#!/usr/bin/env bash

set -euo pipefail

project_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
if [[ -n "${EVERLOOK_VERSION:-${ZEPPELIN_VERSION:-}}" ]]; then
  version=${EVERLOOK_VERSION:-$ZEPPELIN_VERSION}
else
  version=$(cd -- "$project_root" && node -p 'require("./package.json").version')
fi
icon_sizes=(16 32 48 64 128 256 512)
staging=
outfile=${EVERLOOK_OMARCHY_OUTPUT:-${ZEPPELIN_OMARCHY_OUTPUT:-"$project_root/dist/Everlook-${version}-omarchy.zip"}}

cleanup() {
  if [[ -n "$staging" ]]; then
    rm -rf -- "$staging"
  fi
}
trap cleanup EXIT

resolve_app_image() {
  if [[ -n "${EVERLOOK_APPIMAGE:-${ZEPPELIN_APPIMAGE:-}}" ]]; then
    printf '%s' "${EVERLOOK_APPIMAGE:-$ZEPPELIN_APPIMAGE}"
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

prepare_icons() {
  local dest=$1
  local source_dir="$project_root/build"
  local size
  local generated=

  mkdir -p -- "$dest"

  if [[ -f "$source_dir/icon.svg" ]]; then
    install -m 0644 -- "$source_dir/icon.svg" "$dest/icon.svg"
  fi

  if command -v rsvg-convert >/dev/null 2>&1 && [[ -f "$source_dir/icon.svg" ]]; then
    for size in "${icon_sizes[@]}"; do
      rsvg-convert -w "$size" -h "$size" "$source_dir/icon.svg" -o "$dest/icon-${size}.png"
    done
    generated=1
  fi

  if [[ -z "$generated" ]]; then
    for size in "${icon_sizes[@]}"; do
      if [[ -f "$source_dir/icon-${size}.png" ]]; then
        install -m 0644 -- "$source_dir/icon-${size}.png" "$dest/icon-${size}.png"
      fi
    done
  fi

  if [[ ! -f "$dest/icon.svg" ]] && ! compgen -G "$dest/icon-*.png" >/dev/null; then
    printf 'No Everlook icons found under %s.\n' "$source_dir" >&2
    exit 1
  fi
}

if ! command -v zip >/dev/null 2>&1; then
  printf 'zip is required to package the Omarchy installer.\n' >&2
  exit 1
fi

source_app_image=$(resolve_app_image)
if [[ ! -f "$source_app_image" ]]; then
  printf 'AppImage not found: %s\n' "$source_app_image" >&2
  exit 1
fi

case "$outfile" in
  /*) ;;
  *) outfile=$PWD/$outfile ;;
esac

staging=$(mktemp -d --tmpdir everlook-omarchy-stage.XXXXXX)
install -m 0755 -- "$project_root/scripts/install-linux.sh" "$staging/install.sh"
install -m 0755 -- "$project_root/scripts/everlook-launcher.sh" "$staging/everlook-launcher.sh"
install -m 0755 -- "$source_app_image" "$staging/Everlook.AppImage"
prepare_icons "$staging/icons"
cat >"$staging/README.md" <<'EOF'
unzip && ./install.sh
EOF

mkdir -p -- "$(dirname -- "$outfile")"
rm -f -- "$outfile"
(
  cd -- "$staging"
  zip -r "$outfile" install.sh everlook-launcher.sh Everlook.AppImage icons README.md
)

printf 'Wrote %s\n' "$outfile"
