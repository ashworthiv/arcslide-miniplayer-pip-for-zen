#!/bin/bash
# ArcSlide Mini Player (PiP) for Zen — uninstaller. Removes the ArcSlide scripts, and the script loader too
# if nothing else is using it.
set -euo pipefail

JS_FILES=(zen-pipthrow.uc.js zen-pip-arc-controls.uc.js zen-pip-automuted.sys.mjs)
JS_DIRS=(ZenPipAutoMuted)

say() { printf '%s\n' "$*"; }
finish() { say ""; read -r -p "Press Return to close this window." _ || true; }
die() { say ""; say "ERROR: $*"; finish; exit 1; }
ask() { local a; read -r -p "$1 [y/N] " a || true; [[ "$a" =~ ^[Yy] ]]; }

say "=== ArcSlide Mini Player (PiP) for Zen — uninstaller ==="
ZEN_APP=""
for candidate in "/Applications/Zen.app" "$HOME/Applications/Zen.app" "/Applications/Zen Browser.app"; do
  if [[ -d "$candidate" ]]; then ZEN_APP="$candidate"; break; fi
done
[[ -n "$ZEN_APP" ]] || die "Couldn't find Zen.app."
RES="$ZEN_APP/Contents/Resources"

SUPPORT="$HOME/Library/Application Support/zen"
INI="$SUPPORT/profiles.ini"
[[ -f "$INI" ]] || die "No Zen profile found."
REL="$(awk -F= '/^\[Install/{f=1;next} /^\[/{f=0} f && $1=="Default"{print $2; exit}' "$INI")"
if [[ -z "$REL" ]]; then
  REL="$(awk -F= '
    /^\[/ { if (def && path) { print path; exit } def=0; path=""; next }
    $1=="Path" { path=$2 }
    $1=="Default" && $2=="1" { def=1 }
    END { if (def && path) print path }' "$INI")"
fi
[[ -n "$REL" ]] || die "Couldn't work out your default Zen profile."
if [[ "$REL" == /* ]]; then PROFILE="$REL"; else PROFILE="$SUPPORT/$REL"; fi
CHROME="$PROFILE/chrome"
say "Profile: $PROFILE"

if pgrep -f "$ZEN_APP/Contents/MacOS/zen" >/dev/null 2>&1; then
  ask "Zen must quit to uninstall. Quit Zen now?" || die "Cancelled. Nothing was changed."
  osascript -e "tell application \"$ZEN_APP\" to quit" >/dev/null 2>&1 || true
  for _ in $(seq 1 60); do
    pgrep -f "$ZEN_APP/Contents/MacOS/zen" >/dev/null 2>&1 || break
    sleep 0.5
  done
  pgrep -f "$ZEN_APP/Contents/MacOS/zen" >/dev/null 2>&1 && die "Zen didn't quit. Quit it yourself and run this again."
fi

for f in "${JS_FILES[@]}"; do rm -f "$CHROME/JS/$f"; done
for d in "${JS_DIRS[@]}"; do rm -rf "$CHROME/JS/$d"; done
say "Removed the ArcSlide scripts."

# Remove the loader only if no other scripts remain.
if [[ -d "$CHROME/JS" && -z "$(ls -A "$CHROME/JS")" ]]; then
  rmdir "$CHROME/JS"
  rm -rf "$CHROME/utils"
  rm -f "$RES/config.js" "$RES/defaults/pref/config-prefs.js" 2>/dev/null \
    || sudo rm -f "$RES/config.js" "$RES/defaults/pref/config-prefs.js"
  say "Removed the script loader (nothing else was using it)."
else
  say "Kept the script loader: other scripts in $CHROME/JS still use it."
fi

rm -rf "$HOME/Library/Caches/zen/Profiles/$(basename "$PROFILE")/startupCache"
say "Done. Starting Zen ..."
open -a "$ZEN_APP"
finish
