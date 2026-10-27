# How ArcSlide works

Measured on Zen 1.23.4b, macOS.

## Sliding

- **Zen's mini player is a native macOS window drag.** While you drag it, `window.screenX/Y` and the mouse events' `screenX/Y` stay frozen at the pre-drag position until after you let go, and `mouseup` arrives 60–150 ms late. So velocity can't come from the window or the DOM.
- **Velocity comes from the real cursor.** CoreGraphics (`CGEventCreate` / `CGEventGetLocation`, through js-ctypes) is polled every 8 ms during a drag. The moment of release is found by polling the mouse button (`CGEventSourceButtonState`), not by waiting for the late `mouseup`. Velocity is a least-squares fit over the last ~60 ms before release.
- **Throw or drop.** Above `minVelocity` it's a throw; below it the mini player stays where you dropped it, nudged back on-screen if needed.
- **Where it lands.** The corner whose direction from the window centre best matches the throw direction (Arc's rule), on the screen the window is on, `margin` pt inside the visible area (menu bar and Dock excluded).
- **How it moves.** Each axis is an analytic damped spring (response 0.9 s, damping 0.9, Arc's values) seeded with the throw velocity. When an axis hits the screen edge it stops there and that axis's spring restarts from rest, so the mini player slams into the edge and then slides along it into the corner.
- **Two-finger drag.** Inside the wheel handler, `NSApp.currentEvent` is the scroll NSEvent; its `phase`, `momentumPhase` and precise deltas are read through the Objective-C runtime. Only real finger gestures drag (not mouse wheels). The window follows the fingers 1:1, rendered once per frame. Lifting the fingers with speed (the first momentum event) throws it, using the mean of the last few finger deltas × 90 as velocity.
- **No fighting Firefox.** Firefox snaps the PiP window to a corner on Cmd+drag-release. ArcSlide wraps `Player.onMouseUp` to skip that when it handled the drag.

## Pop out (any video)

Firefox's tab-switch auto-PiP (`media.videocontrols.picture-in-picture.enable-when-switching-tabs.enabled`) refuses a lot of videos:

- muted tabs (parent side) and muted `<video>`s (content side);
- videos under 45 s, without an audio track, or smaller than 140 px (`videoIsPiPEligible`);
- videos the page pauses itself on `visibilitychange`, which is what Instagram and many feeds do.

`zen-pip-automuted.sys.mjs` replaces the parent's handler for `PictureInPicture:VideoTabHidden` and routes it to its own window actor (`ZenPipAutoMuted`). The actor:

- listens for `visibilitychange` in the capture phase, which runs before the page's own listeners, and records the largest playing video before the page can pause it;
- opens that video with Firefox's own `PictureInPictureLauncher` actor, so it behaves like a normal auto-PiP and closes when you return to the tab;
- if the page paused it, plays it again once Firefox makes the tab visible for PiP, so the player shows the right play state.

With `autoPipAnyVideo` on, it also sets Firefox's `video-toggle.always-show` pref on the default branch (so a value you set yourself still wins). That drops the 45 s / audio / size rules for the hover toggle, the address-bar PiP button and Zen's media-bar PiP button.

## Controls

`zen-pip-arc-controls.uc.js` hides Firefox's controls (only their children: `#controls` itself carries the window's drag region) and draws Arc-style controls on top. Every button drives Firefox's own player: its hidden buttons, `Player.setVideoTime`, `Player.toggleMute`.

The sound button uses the **tab** mute, the same one Zen's sidebar media controls use, so the two stay in sync. If the `<video>` itself is muted, it unmutes that too.

## Firefox internals this depends on (what can break on updates)

- the PiP window URL `chrome://global/content/pictureinpicture/player.xhtml` (the `@include`)
- `Player` as a top-level `let` in player.js: `onMouseUp`, `setVideoTime`, `toggleMute`, `isPlaying`, `isMuted`
- player.xhtml element ids: `#controls`, `#playpause`, `#seekForward`, `#seekBackward`, `#unpip`, `#minimize`, `#close`, `#scrubber`
- `PictureInPicture.weakWinToBrowser`, `weakAutoPipBrowserClosedDeliberately`, `PictureInPictureToggleParent.prototype.receiveMessage`
- `PictureInPictureLauncherChild.findVideoToPiP` / `togglePictureInPicture`, `PictureInPictureChild.videoIsPlaying`
- Zen's `gZenMediaController.onAudioPlaybackStopped()` (refreshes the sidebar's mute icon)
- `browser.documentGlobal`, `nsIScreenManager.screenForRect`, `nsIScreen.GetAvailRectDisplayPix`
- js-ctypes with CoreGraphics and the Objective-C runtime

If one of these changes, the affected feature stops working; the rest keeps going, and Zen falls back to its stock behaviour.

## Dev harness

`test/` holds a bun + Marionette harness that launches a throwaway Zen (temporary profile, port 2829) and a real mouse/scroll event synthesizer (`swiftc -O test/mouse.swift -o test/mouse`). Generate the test videos with `scripts/make-fixtures.sh`. `bun test/probe-native-drag.ts` reproduces the native-drag measurements. It moves your real mouse.

`scripts/build-release.sh` builds `dist/ArcSlide.zip` from `src/`, `installer/` and `vendor/`.

Prefs and file names keep their original `zen.pipthrow` / `zen-pip*` names so updating over an older install doesn't leave duplicates behind.
