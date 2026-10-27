# ArcSlide Mini Player for Zen

Arc's mini player, back, in Zen Browser on macOS.

- **Pop out**: switch tabs and the playing video pops out into a floating mini player. That includes muted videos, short clips and reels, and sites like Instagram that pause the video when you leave the tab.
- **Slide**: drag the mini player and let go with some speed, or hover it and flick with two fingers on a trackpad / Magic Mouse. It carries your momentum, hits the screen edge and slides into the corner. Drag, pause, then release, and it stays where you put it.
- **Arc's controls**: Back to Tab, Minimize, Close, play/pause, ±15 s, a timeline you can click or drag (drag upward while scrubbing for fine seeking), and a sound on/off button in the bottom-right corner. Right-click the video for Mute and Copy URL.

## Install

1. Double-click `Install.command`. If macOS says it can't be opened, open **System Settings → Privacy & Security**, scroll down and click **Open Anyway** (or right-click `Install.command` → Open).
2. Answer the prompts and press Return to keep the defaults. Zen quits and reopens by itself; your tabs come back.

Already installed? Just run `Install.command` again: it updates in place.
Re-run it after every Zen update too, because updates replace the files the loader needs inside Zen.app.

## Uninstall

Run `Uninstall.command`.

## Optional tweaks

You don't need to change anything: it works out of the box. Only if you want to fine-tune it, open `about:config` and search `zen.pipthrow`:

| Pref | Default | What it does |
|---|---|---|
| `zen.pipthrow.enabled` | true | master switch for sliding |
| `zen.pipthrow.minVelocity` | 120 | release speed (pt/s) that counts as a throw |
| `zen.pipthrow.maxThrowVelocity` | 1500 | how hard a throw can launch the window (0 = no limit) |
| `zen.pipthrow.responseMs` / `dampingPct` | 900 / 90 | the glide spring (Arc's values) |
| `zen.pipthrow.margin` | 10 | gap from the screen edges |
| `zen.pipthrow.swipe` | true | two-finger trackpad / Magic Mouse dragging |
| `zen.pipthrow.swipeInvert` | false | flip two-finger dragging direction |
| `zen.pipthrow.arcControls` | true | Arc-style controls (false = Zen's stock controls) |
| `zen.pipthrow.autoPipMuted` | true | pop out muted videos on tab switch too |
| `zen.pipthrow.autoPipAnyVideo` | true | pop out any video, not just Firefox's picks (45 s+, with sound) |
| `zen.pipthrow.debug` | false | write a gesture log to the profile folder |

## What it changes

- Two files inside `Zen.app/Contents/Resources` (`config.js`, `defaults/pref/config-prefs.js`): the [fx-autoconfig](https://github.com/MrOtherGuy/fx-autoconfig) script loader (MPL-2.0; license in `payload/licenses`).
- Your profile's `chrome/utils` (the loader) and `chrome/JS` (the ArcSlide scripts).
- Optionally, Zen's "pop out video when switching tabs" setting.

If you already use Sine or another mod manager, the installer warns before replacing its loader.
