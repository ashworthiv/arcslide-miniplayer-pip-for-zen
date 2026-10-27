#!/bin/bash
# ArcSlide Mini Player (PiP) for Zen — installer.
# Installs the fx-autoconfig script loader into Zen and the ArcSlide scripts into your
# default Zen profile. Re-run after every Zen update (updates replace Zen.app's files).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
PAYLOAD="$HERE/payload"
JS_FILES=(zen-pipthrow.uc.js zen-pip-arc-controls.uc.js zen-pip-automuted.sys.mjs)
JS_DIRS=(ZenPipAutoMuted)

say() { printf '%s\n' "$*"; }
finish() { say ""; read -r -p "Press Return to close this window." _ || true; }
die() { say ""; say "ERROR: $*"; finish; exit 1; }
ask() { local a; read -r -p "$1 [y/N] " a || true; [[ "$a" =~ ^[Yy] ]]; }
ask_yes() { local a; read -r -p "$1 [Y/n] " a || true; [[ ! "$a" =~ ^[Nn] ]]; }

say "=== ArcSlide Mini Player (PiP) for Zen — installer ==="
[[ "$(uname)" == "Darwin" ]] || die "This installer is for macOS."
[[ -d "$PAYLOAD" ]] || die "The 'payload' folder is missing next to this installer."

# --- Zen.app ----------------------------------------------------------------------------
ZEN_APP=""
for candidate in "/Applications/Zen.app" "$HOME/Applications/Zen.app" "/Applications/Zen Browser.app"; do
  if [[ -d "$candidate" ]]; then ZEN_APP="$candidate"; break; fi
done
[[ -n "$ZEN_APP" ]] || die "Couldn't find Zen.app in /Applications or ~/Applications."
RES="$ZEN_APP/Contents/Resources"
say "Zen:     $ZEN_APP"

# --- Default profile (from profiles.ini) ------------------------------------------------
SUPPORT="$HOME/Library/Application Support/zen"
INI="$SUPPORT/profiles.ini"
[[ -f "$INI" ]] || die "No Zen profile found. Open Zen once, quit it, then run this again."
# Prefer the profile this Zen install uses ([Install...] Default=), else the Default=1 profile.
REL="$(awk -F= '/^\[Install/{f=1;next} /^\[/{f=0} f && $1=="Default"{print $2; exit}' "$INI")"
if [[ -z "$REL" ]]; then
  REL="$(awk -F= '
    /^\[/ { if (def && path) { print path; exit } def=0; path=""; next }
    $1=="Path" { path=$2 }
    $1=="Default" && $2=="1" { def=1 }
    END { if (def && path) print path }' "$INI")"
fi
[[ -n "$REL" ]] || die "Couldn't work out your default Zen profile from $INI."
if [[ "$REL" == /* ]]; then PROFILE="$REL"; else PROFILE="$SUPPORT/$REL"; fi
[[ -d "$PROFILE" ]] || die "Profile folder not found: $PROFILE"
say "Profile: $PROFILE"
CHROME="$PROFILE/chrome"

# --- Another script loader already there? -----------------------------------------------
if [[ -d "$CHROME/utils" && ! -f "$CHROME/utils/boot.sys.mjs" ]]; then
  say ""
  say "Your profile already has a chrome/utils folder that isn't fx-autoconfig"
  say "(for example from Sine or another mod manager). Installing would replace it."
  ask "Replace it anyway?" || die "Cancelled. Nothing was changed."
fi

# --- Quit Zen ---------------------------------------------------------------------------
if pgrep -f "$ZEN_APP/Contents/MacOS/zen" >/dev/null 2>&1; then
  say ""
  ask "Zen is running and must quit to install (your tabs are restored on relaunch). Quit Zen now?" \
    || die "Cancelled. Nothing was changed."
  osascript -e "tell application \"$ZEN_APP\" to quit" >/dev/null 2>&1 || true
  for _ in $(seq 1 60); do
    pgrep -f "$ZEN_APP/Contents/MacOS/zen" >/dev/null 2>&1 || break
    sleep 0.5
  done
  pgrep -f "$ZEN_APP/Contents/MacOS/zen" >/dev/null 2>&1 && die "Zen didn't quit. Quit it yourself (Cmd+Q) and run this again."
fi

# --- 1. Script loader into Zen.app ------------------------------------------------------
say ""
say "Installing the script loader into Zen.app ..."
copy_program() {
  mkdir -p "$RES/defaults/pref"
  cp "$PAYLOAD/program/config.js" "$RES/config.js"
  cp "$PAYLOAD/program/defaults/pref/config-prefs.js" "$RES/defaults/pref/config-prefs.js"
}
if ! copy_program 2>/dev/null; then
  say "Zen.app isn't writable by your user; asking for your Mac password to copy 2 files."
  sudo mkdir -p "$RES/defaults/pref"
  sudo cp "$PAYLOAD/program/config.js" "$RES/config.js"
  sudo cp "$PAYLOAD/program/defaults/pref/config-prefs.js" "$RES/defaults/pref/config-prefs.js"
fi

# --- 2. Loader + scripts into the profile ----------------------------------------------
say "Installing ArcSlide into your profile ..."
mkdir -p "$CHROME/JS"
rm -rf "$CHROME/utils"
cp -R "$PAYLOAD/profile/chrome/utils" "$CHROME/utils"
for f in "${JS_FILES[@]}"; do cp "$PAYLOAD/profile/chrome/JS/$f" "$CHROME/JS/$f"; done
for d in "${JS_DIRS[@]}"; do rm -rf "$CHROME/JS/$d"; cp -R "$PAYLOAD/profile/chrome/JS/$d" "$CHROME/JS/$d"; done

# --- 3. Optional: auto Picture-in-Picture on tab switch ---------------------------------
PREFS="$PROFILE/prefs.js"
AUTO_PIP='media.videocontrols.picture-in-picture.enable-when-switching-tabs.enabled'
say ""
if ask_yes "Pop playing videos out automatically when you switch tabs (auto Picture-in-Picture)?"; then
  touch "$PREFS"
  sed -i '' "/\"$AUTO_PIP\"/d" "$PREFS"
  printf 'user_pref("%s", true);\n' "$AUTO_PIP" >> "$PREFS"
  say "Auto Picture-in-Picture on tab switch: on."
fi

# --- 4. Clear Zen's startup cache so the new scripts load -------------------------------
rm -rf "$HOME/Library/Caches/zen/Profiles/$(basename "$PROFILE")/startupCache"

say ""
say "Done. Starting Zen ..."
open -a "$ZEN_APP"
say ""
say "How to use it: open a video in Picture-in-Picture, then throw the window toward a"
say "corner with a click-drag, or hover it and flick with two fingers on a trackpad."
say "Mute with the speaker button (bottom-right) or right-click. Settings: about:config, search 'zen.pipthrow'."
say "Remember to re-run this installer after Zen updates."
finish
