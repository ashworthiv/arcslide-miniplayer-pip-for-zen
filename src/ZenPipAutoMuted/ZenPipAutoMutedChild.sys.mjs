// Content side of tab-switch auto-PiP. Firefox's PictureInPictureLauncherChild.autoToggle()
// skips muted videos, videos under 45 s, videos without an audio track, and videos the page
// paused itself when the tab went hidden (Instagram, many feeds). This picks the video the
// user was actually watching and opens it with Firefox's own launcher actor, so the window
// is a normal auto-PiP (closes again when you return to the tab).
import { PictureInPictureChild } from "moz-src:///toolkit/actors/PictureInPictureChild.sys.mjs";

const MIN_SIDE = 100; // px; skips tracking pixels and avatar-sized loops
const HIDDEN_GRACE_MS = 2000; // how long a video paused by the page on tab hide still counts
const RESUME_WAIT_MS = 3000; // how long to wait for Firefox to reactivate the tab
const PLAYER_SETTLE_MS = 500; // time for the PiP player to start listening to the video

const anyVideo = () => Services.prefs.getBoolPref("zen.pipthrow.autoPipAnyVideo", true);

export class ZenPipAutoMutedChild extends JSWindowActorChild {
  #lastPlaying = null; // { video: WeakRef, t: ms } snapshot taken as the tab goes hidden

  // Registered with capture, so this runs before the page's own visibilitychange
  // handlers get a chance to pause the video.
  handleEvent(event) {
    if (event.type !== "visibilitychange" || this.document?.visibilityState !== "hidden") return;
    const video = this.#largestPlaying();
    this.#lastPlaying = video ? { video: new WeakRef(video), t: Date.now() } : null;
  }

  #largestPlaying() {
    let best = null;
    let bestArea = 0;
    for (const v of this.document?.querySelectorAll("video") ?? []) {
      if (!PictureInPictureChild.videoIsPlaying(v)) continue;
      const area = v.clientWidth * v.clientHeight;
      if (v.clientWidth < MIN_SIDE || v.clientHeight < MIN_SIDE || area <= bestArea) continue;
      best = v;
      bestArea = area;
    }
    return best;
  }

  #pick() {
    const launcher = this.manager.getActor("PictureInPictureLauncher");
    if (!anyVideo()) {
      const video = launcher.findVideoToPiP(this.document);
      return video && PictureInPictureChild.videoIsPlaying(video) && PictureInPictureChild.videoIsPiPEligible(video)
        ? { video, resume: false }
        : null;
    }
    const playing = this.#largestPlaying();
    if (playing) return { video: playing, resume: false };
    const snap = this.#lastPlaying;
    const video = snap?.video.deref();
    if (video?.isConnected && Date.now() - snap.t < HIDDEN_GRACE_MS) return { video, resume: video.paused };
    return null;
  }

  // The page paused the video as the tab hid. Firefox makes the tab visible again for the
  // PiP; the page may resume it itself at that moment, before the PiP player is listening,
  // so the player would show it as paused. Once the player has settled, play it if still
  // paused, or pause+play in the same task (inaudible) so the player hears "playing".
  #resume(video) {
    const win = this.contentWindow;
    if (!win) return;
    const settle = () => win.setTimeout(() => {
      if (!video.isConnected) return;
      if (!video.paused) video.pause();
      video.play().catch(() => {});
    }, PLAYER_SETTLE_MS);
    if (this.document.visibilityState === "visible") {
      settle();
      return;
    }
    const onVisible = () => {
      if (this.document?.visibilityState !== "visible") return;
      win.removeEventListener("visibilitychange", onVisible, true);
      win.clearTimeout(giveUp);
      settle();
    };
    const giveUp = win.setTimeout(() => win.removeEventListener("visibilitychange", onVisible, true), RESUME_WAIT_MS);
    win.addEventListener("visibilitychange", onVisible, true);
  }

  // Returns what it decided (visible to sendQuery callers, for diagnosing sites).
  async receiveMessage(message) {
    if (message.name !== "AutoToggle") return null;
    if (!this.document) return { opened: false, reason: "no document" };
    const picked = this.#pick();
    if (!picked) {
      const videos = [...this.document.querySelectorAll("video")];
      return {
        opened: false,
        reason: videos.length ? "no playing video" : "no video",
        videos: videos.map(v => ({ paused: v.paused, readyState: v.readyState, duration: v.duration, w: v.clientWidth, h: v.clientHeight })),
      };
    }
    if (picked.video.muted && !Services.prefs.getBoolPref("zen.pipthrow.autoPipMuted", true)) {
      return { opened: false, reason: "muted" };
    }
    const launcher = this.manager.getActor("PictureInPictureLauncher");
    await launcher.togglePictureInPicture({ video: picked.video, reason: "AutoPip" }, false);
    if (picked.resume) this.#resume(picked.video);
    return { opened: true, resumed: picked.resume };
  }
}
