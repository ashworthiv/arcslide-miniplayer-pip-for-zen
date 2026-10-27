#!/bin/bash
# ArcSlide Mini Player for Zen — one-line installer.
#   curl -fsSL https://raw.githubusercontent.com/ashworthiv/arcslide-miniplayer-zen/main/install.sh | bash
# Downloads the latest release and runs its Install.command. Files fetched with curl aren't
# quarantined, so macOS doesn't block the installer the way it can for a browser download.
set -euo pipefail

REPO="ashworthiv/arcslide-miniplayer-zen"
URL="https://github.com/$REPO/releases/latest/download/ArcSlide.zip"

[[ "$(uname)" == "Darwin" ]] || { echo "ArcSlide is for Zen on macOS."; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
echo "Downloading ArcSlide ..."
curl -fsSL "$URL" -o "$TMP/ArcSlide.zip"
unzip -q "$TMP/ArcSlide.zip" -d "$TMP"

# The installer asks questions; read them from the terminal, not from this piped script.
bash "$TMP/ArcSlide/Install.command" < /dev/tty
