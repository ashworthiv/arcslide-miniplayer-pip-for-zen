// ==UserScript==
// @name           Zen PiP auto-PiP when muted
// @description    Tab-switch auto Picture-in-Picture for any playing video: muted, short, silent, or paused by the page on tab switch.
// ==/UserScript==

// Background module (fx-autoconfig imports *.sys.mjs once, in the parent process).
//
// Firefox's auto-PiP refuses muted media in two places: the parent drops the
// VideoTabHidden message when the tab is muted, and the child's autoToggle() skips
// videos with video.muted. Neither is a pref. This replaces the parent-side handler
// for that one message and routes it to our own child actor, which picks the video the user
// was watching (see ZenPipAutoMutedChild). zen.pipthrow.autoPipAnyVideo also turns on
// Firefox's always-show pref, which drops the 45 s / has-audio / 140 px rules for the hover
// toggle, the address-bar PiP button and Zen's media-bar PiP button.

import {
  PictureInPicture,
  PictureInPictureToggleParent,
} from "moz-src:///toolkit/components/pictureinpicture/PictureInPicture.sys.mjs";

const PREF = "zen.pipthrow.autoPipMuted";
const ANY_VIDEO_PREF = "zen.pipthrow.autoPipAnyVideo";
const ALWAYS_SHOW = "media.videocontrols.picture-in-picture.video-toggle.always-show";
const PIP_ENABLED = "media.videocontrols.picture-in-picture.enabled";
const PIP_WHEN_SWITCHING_TABS = "media.videocontrols.picture-in-picture.enable-when-switching-tabs.enabled";
const ACTOR = "ZenPipAutoMuted";
const BASE = "chrome://userscripts/content/ZenPipAutoMuted/";

const defaults = Services.prefs.getDefaultBranch("");
defaults.setBoolPref(PREF, true);
defaults.setBoolPref(ANY_VIDEO_PREF, true);
// Default branch only, so a value the user set in about:config still wins.
const syncAlwaysShow = () => defaults.setBoolPref(ALWAYS_SHOW, Services.prefs.getBoolPref(ANY_VIDEO_PREF, true));
syncAlwaysShow();
Services.prefs.addObserver(ANY_VIDEO_PREF, syncAlwaysShow);

try {
  ChromeUtils.registerWindowActor(ACTOR, {
    parent: { esModuleURI: `${BASE}ZenPipAutoMutedParent.sys.mjs` },
    child: {
      esModuleURI: `${BASE}ZenPipAutoMutedChild.sys.mjs`,
      // Capture: snapshot the playing video before the page pauses it on tab hide.
      events: { visibilitychange: { capture: true } },
    },
    messageManagerGroups: ["browsers"],
    allFrames: true,
    // Required for the actor to exist in normal (untrusted) web content processes.
    safeForUntrustedWebProcess: true,
  });
} catch (e) {
  // Already registered (module re-imported).
  if (e.name !== "NotSupportedError") console.error("[zen-pip-automuted] actor registration failed", e);
}

const proto = PictureInPictureToggleParent.prototype;
if (!proto.receiveMessage.__zenPipAutoMuted) {
  const original = proto.receiveMessage;
  const patched = function (message) {
    if (
      message.name === "PictureInPicture:VideoTabHidden" &&
      (Services.prefs.getBoolPref(PREF, true) || Services.prefs.getBoolPref(ANY_VIDEO_PREF, true)) &&
      Services.prefs.getBoolPref(PIP_ENABLED, true) &&
      Services.prefs.getBoolPref(PIP_WHEN_SWITCHING_TABS, false)
    ) {
      // Same gates as Firefox's own handler, except browser.audioMuted (checked below).
      const browser = this.browsingContext.top.embedderElement;
      if (!browser) return undefined;
      if (PictureInPicture.weakAutoPipBrowserClosedDeliberately.has(browser)) {
        PictureInPicture.weakAutoPipBrowserClosedDeliberately.delete(browser);
        return undefined;
      }
      if (browser.documentGlobal.gBrowser?.selectedBrowser === browser) return undefined;
      if (browser.audioMuted && !Services.prefs.getBoolPref(PREF, true)) return undefined;
      try {
        this.browsingContext.currentWindowGlobal.getActor(ACTOR).sendAsyncMessage("AutoToggle");
      } catch (e) {
        console.error("[zen-pip-automuted] falling back to Firefox auto-PiP", e);
        return original.call(this, message);
      }
      return undefined;
    }
    return original.call(this, message);
  };
  patched.__zenPipAutoMuted = true;
  proto.receiveMessage = patched;
}
