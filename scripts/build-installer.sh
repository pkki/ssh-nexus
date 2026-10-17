#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ ! -f "release/win-unpacked/SSH Nexus.exe" ]]; then
  echo "release/win-unpacked is missing; building the Windows directory first..." >&2
  rm -rf node_modules/cpu-features release/win-unpacked
  npx electron-builder --win dir
fi

VERSION="$(node -p "require('./package.json').version")"
FILE_VERSION="${VERSION}.0"
MAKENSIS="${MAKENSIS:-}"
if [[ -z "$MAKENSIS" ]]; then
  MAKENSIS="$(find "$HOME/.cache/electron-builder" -type f -path '*/linux/makensis' -perm -u+x 2>/dev/null | head -n 1 || true)"
fi
if [[ -z "$MAKENSIS" || ! -x "$MAKENSIS" ]]; then
  echo "Linux makensis was not found. Run electron-builder once so its NSIS toolchain is downloaded." >&2
  exit 1
fi

rm -f "release/SSH-Nexus-Setup-${VERSION}.exe"
"$MAKENSIS" \
  -DAPP_VERSION="$VERSION" \
  -DAPP_FILE_VERSION="$FILE_VERSION" \
  -DPROJECT_DIR="$ROOT" \
  installer/ssh-nexus.nsi

echo "Created: $ROOT/release/SSH-Nexus-Setup-${VERSION}.exe"
