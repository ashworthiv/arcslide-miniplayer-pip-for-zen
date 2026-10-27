#!/bin/bash
# Builds dist/ArcSlide.zip: the installers, an end-user README, the scripts from src/ and the
# vendored fx-autoconfig loader, laid out the way installer/Install.command expects.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/dist"
PKG="$OUT/ArcSlide"
FX="$ROOT/vendor/fx-autoconfig"

rm -rf "$PKG" "$OUT/ArcSlide.zip"
mkdir -p "$PKG/payload/program" "$PKG/payload/profile/chrome" "$PKG/payload/licenses"

cp "$ROOT/installer/Install.command" "$ROOT/installer/Uninstall.command" "$PKG/"
chmod +x "$PKG/Install.command" "$PKG/Uninstall.command"
cp "$ROOT/installer/README.md" "$PKG/README.md"

cp -R "$FX/program/." "$PKG/payload/program/"
cp -R "$FX/utils" "$PKG/payload/profile/chrome/utils"
cp -R "$ROOT/src" "$PKG/payload/profile/chrome/JS"
cp "$FX/LICENSE" "$PKG/payload/licenses/fx-autoconfig-LICENSE-MPL-2.0.txt"
cp "$FX/SOURCE.txt" "$PKG/payload/licenses/fx-autoconfig-SOURCE.txt"
cp "$ROOT/LICENSE" "$PKG/payload/licenses/ArcSlide-LICENSE-MPL-2.0.txt"

# No Finder metadata or AppleDouble (._*) files in the zip.
find "$PKG" -name .DS_Store -delete
find "$PKG" -exec xattr -c {} \;
(cd "$OUT" && zip -qr -X ArcSlide.zip ArcSlide)
echo "Built $OUT/ArcSlide.zip ($(wc -c < "$OUT/ArcSlide.zip" | tr -d ' ') bytes)"
