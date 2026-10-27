// ==UserScript==
// @name           Zen PiP Arc Controls
// @description    Arc's mini-player hover controls for the Picture-in-Picture window.
// @include        chrome://global/content/pictureinpicture/player.xhtml
// ==/UserScript==

// Arc-style video PiP controls:
//   top:    [↖ Back to Tab]        host        [– Minimize] [× Close]
//   center:          [↺15]   [❚❚]   [↻15]
//   bottom: scrubbable timeline (drag upward for fine seeking), sound toggle above its right end
//   right-click: Mute / Unmute, Copy URL
// Layout scales by size class from the window width, like Arc: <280, 280-400, 400-600, 600+.
// Every control drives Firefox's own player (its hidden buttons or Player methods).
(function zenPipArcControls(win) {
  "use strict";

  if (win.__zenPipArcControls) return;
  win.__zenPipArcControls = true;

  const PREF = "zen.pipthrow.arcControls";
  Services.prefs.getDefaultBranch("").setBoolPref(PREF, true);
  if (!Services.prefs.getBoolPref(PREF, true)) return;

  const doc = win.document;
  const HTML = "http://www.w3.org/1999/xhtml";
  const SVG = "http://www.w3.org/2000/svg";
  const XUL = "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul";

  // Arc constants.
  // Arc defines classes at 280 / 400 / 600pt, but its lookup reads the environment before
  // it is installed, so in practice the compact layout shows until the window is large.
  // These breaks reproduce what Arc actually displays: compact below 600pt, full at 600+.
  const SIZE_CLASS_BREAKS = [600, 600, 600]; // width -> class 0 or 3
  const SHOW_AFTER_MOVE_PT = 3; // pointer must move this far to reveal the controls
  const HIDE_AFTER_MS = 3000; // auto-hide after the pointer rests
  const SEEK_STEPS = 3; // Firefox seeks 5s per step; Arc's buttons skip 15s
  const PRECISION_PX = 60; // scrubbing: every 60pt dragged upward = one more x of precision
  const MAX_PRECISION = 15;

  const CSS = `
    /* Hide Firefox's controls but keep #controls itself rendered: it carries the window's
       -moz-window-dragging region, and hiding it makes the PiP undraggable. */
    #controls > * { visibility: hidden !important; }

    #zpc {
      position: fixed; inset: 0; z-index: 2147483647; pointer-events: none;
      font: 500 12px/1 -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif;
      color: #fff; user-select: none;
      --pad: 12px; --btn-pad: 8px; --play: 48px; --skip: 0px; --bar-inset: 12px; --bar-bottom: 4px;
    }
    #zpc[data-class="1"] { --pad: 16px; --play: 50px; --skip: 36px; --bar-inset: 16px; --bar-bottom: 8px; }
    #zpc[data-class="2"] { --pad: 16px; --btn-pad: 10px; --play: 75px; --skip: 44px; --bar-inset: 16px; --bar-bottom: 8px; }
    #zpc[data-class="3"] { --pad: 16px; --btn-pad: 10px; --play: 75px; --skip: 44px; --bar-inset: 16px; --bar-bottom: 8px; }
    #zpc[data-hidden-cursor] { cursor: none; }

    #zpc .scrim {
      position: absolute; inset: 0; background: #000; opacity: 0;
      transition: opacity 200ms ease-in-out;
    }
    #zpc[data-visible] .scrim { opacity: .33; }
    #zpc .layer { position: absolute; inset: 0; opacity: 0; transition: opacity 300ms ease; }
    #zpc[data-visible] .layer { opacity: 1; }
    #zpc[data-visible] .hit { pointer-events: auto; }
    #zpc .shadow { filter: drop-shadow(0 0 5px rgba(0,0,0,.2)); }

    #zpc .top {
      position: absolute; top: var(--pad); left: var(--pad); right: var(--pad); height: 28px;
      display: flex; align-items: center; justify-content: space-between; gap: 8px;
    }
    #zpc .group { display: flex; gap: 8px; flex: none; }
    #zpc .title {
      flex: 1; min-width: 0; height: 26px; line-height: 26px; text-align: center;
      font-size: 13px; font-weight: 500;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    #zpc .pill {
      -moz-window-dragging: no-drag; display: flex; align-items: center; justify-content: center;
      gap: 6px; height: 28px; min-width: 28px; padding: 0 var(--btn-pad); box-sizing: border-box;
      border: 0; border-radius: 6px; color: #fff; font: inherit; letter-spacing: .1px;
      background: color(display-p3 .98 .984 1 / .10);
      transition: transform 300ms ease, background-color 120ms ease; cursor: default;
    }
    #zpc .pill:hover { background: color(display-p3 .98 .984 1 / .15); }
    #zpc .pill:active { background: rgba(255,255,255,.15); transform: scale(.95); }
    #zpc .pill svg { width: 12px; height: 12px; flex: none; transition: transform 200ms ease; }
    #zpc .pill.back:hover svg { transform: translate(-2px, -2px); }
    #zpc .pill .label { display: none; }
    #zpc[data-class="2"] .pill .label, #zpc[data-class="3"] .pill .label { display: inline; }

    #zpc .center {
      position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%);
      display: flex; align-items: center;
    }
    #zpc .center button {
      -moz-window-dragging: no-drag; border: 0; padding: 0; background: none; color: #fff;
      cursor: default; display: grid; place-items: center; transition: transform 250ms cubic-bezier(.3,1.4,.6,1);
    }
    #zpc .play { width: var(--play); height: var(--play); padding: 0 8px !important; box-sizing: content-box; }
    #zpc[data-class="0"] .play { padding: 0 !important; }
    #zpc .play:hover { transform: scale(1.05); }
    #zpc .play:active { transform: scale(.8); }
    #zpc .play svg { grid-area: 1 / 1; width: 100%; height: 100%; transition: opacity 200ms ease, transform 250ms cubic-bezier(.3,1.4,.6,1); }
    #zpc .play svg.off { opacity: 0; transform: scale(.4); }
    #zpc .skip { width: var(--skip); height: var(--skip); margin: 0 18px; }
    #zpc[data-class="0"] .skip { display: none !important; }
    #zpc .skip:hover { transform: scale(1.075); }
    #zpc .skip:active { transform: scale(.925); }
    #zpc .skip svg { width: 100%; height: 100%; transition: transform 250ms cubic-bezier(.3,1.4,.6,1); }
    #zpc .skip.spin-back svg { transform: rotate(-45deg); }
    #zpc .skip.spin-fwd svg { transform: rotate(45deg); }

    #zpc .timeline {
      -moz-window-dragging: no-drag; position: absolute; left: var(--bar-inset); right: var(--bar-inset);
      bottom: var(--bar-bottom); height: 20px; display: flex; align-items: flex-end; cursor: default;
    }
    #zpc .track {
      position: relative; width: 100%; height: 5px; border-radius: 999px;
      background: rgba(255,255,255,.3); transition: height 200ms ease;
    }
    #zpc .timeline:hover .track, #zpc .timeline[data-scrubbing] .track { height: 10px; }
    #zpc .fill { position: absolute; inset: 0 auto 0 0; width: 4px; background: #fff; border-radius: inherit; }
    #zpc .hint {
      position: absolute; left: 0; right: 0; bottom: calc(var(--bar-bottom) + 24px); text-align: center;
      font-size: 13px; font-weight: 600; opacity: 0; transition: opacity 300ms ease;
    }
    #zpc .hint[data-on] { opacity: 1; }
    #zpc[data-no-timeline] .timeline, #zpc[data-no-timeline] .skip { display: none !important; }

    /* Sound toggle (not in Arc, which only has Mute in the right-click menu): bottom-right,
       just above the timeline, where most players keep volume. */
    #zpc .sound {
      position: absolute; right: var(--bar-inset); bottom: calc(var(--bar-bottom) + 26px);
      width: 28px; padding: 0; display: grid; place-items: center;
    }
    #zpc[data-no-timeline] .sound { bottom: var(--pad); }
    #zpc .sound svg { width: 16px; height: 16px; grid-area: 1 / 1; transition: opacity 150ms ease; }
    #zpc .sound svg.off { opacity: 0; }

    /* Arc's window edge: 1pt white at 12%. */
    #zpc .edge { position: absolute; inset: 0; box-shadow: inset 0 0 0 1px rgba(255,255,255,.12); }
  `;

  // --- Icons ----------------------------------------------------------------------------
  function svg(viewBox, children) {
    const el = doc.createElementNS(SVG, "svg");
    el.setAttribute("viewBox", viewBox);
    el.setAttribute("fill", "none");
    for (const [tag, attrs] of children) {
      const c = doc.createElementNS(SVG, tag);
      for (const [k, v] of Object.entries(attrs)) if (k !== "text") c.setAttribute(k, v);
      if (attrs.text) c.textContent = attrs.text;
      el.append(c);
    }
    return el;
  }
  const line = (d, w = "1.5") => ["path", { d, stroke: "currentColor", "stroke-width": w, "stroke-linecap": "round", "stroke-linejoin": "round" }];
  const ICONS = {
    // Arc's custom 1pt stroked arrow, pointing up-left.
    back: () => svg("0 0 12 12", [line("M2.5 2.5h5.5M2.5 2.5V8M2.5 2.5l7.5 7.5", "1.4")]),
    minus: () => svg("0 0 12 12", [line("M1.5 6h9", "1.6")]),
    xmark: () => svg("0 0 12 12", [line("M2 2l8 8M10 2l-8 8", "1.6")]),
    // SF "speaker.wave.2.fill" / "speaker.slash.fill".
    speaker: () => svg("0 0 16 16", [
      ["path", { d: "M2 6h2.2L7.6 3.2c.4-.3.9 0 .9.4v8.8c0 .5-.5.7-.9.4L4.2 10H2a.6.6 0 0 1-.6-.6V6.6c0-.3.3-.6.6-.6z", fill: "currentColor" }],
      line("M10.6 5.8a3 3 0 0 1 0 4.4M12.6 3.9a5.7 5.7 0 0 1 0 8.2", "1.4"),
    ]),
    speakerOff: () => svg("0 0 16 16", [
      ["path", { d: "M2 6h2.2L7.6 3.2c.4-.3.9 0 .9.4v8.8c0 .5-.5.7-.9.4L4.2 10H2a.6.6 0 0 1-.6-.6V6.6c0-.3.3-.6.6-.6z", fill: "currentColor" }],
      line("M10.8 6l4 4M14.8 6l-4 4", "1.4"),
    ]),
    // SF "pause" (bold) and "play.fill".
    pause: () => svg("0 0 48 48", [
      ["rect", { x: "13", y: "7", width: "6.5", height: "34", rx: "3.25", fill: "currentColor" }],
      ["rect", { x: "28.5", y: "7", width: "6.5", height: "34", rx: "3.25", fill: "currentColor" }],
    ]),
    play: () => svg("0 0 48 48", [["path", { d: "M15 9.6c0-2.2 2.4-3.5 4.3-2.4l21.6 12.9c1.9 1.1 1.9 3.8 0 4.9L19.3 37.9c-1.9 1.1-4.3-.2-4.3-2.4z", fill: "currentColor" }]]),
    // Arc's GoBack / GoForward template images with a bold "15".
    skip: forward => svg("0 0 44 44", [
      line(forward ? "M22 6.5A15.5 15.5 0 1 1 6.5 22" : "M22 6.5A15.5 15.5 0 1 0 37.5 22", "3"),
      line(forward ? "M18 2.5l4.2 4-4.2 4" : "M26 2.5l-4.2 4 4.2 4", "3"),
      ["text", { x: "22", y: "27", "text-anchor": "middle", fill: "currentColor", "font-size": "13.2", "font-weight": "700", "font-family": "-apple-system, sans-serif", text: "15" }],
    ]),
  };

  function el(tag, cls, ...kids) {
    const e = doc.createElementNS(HTML, tag);
    if (cls) e.className = cls;
    e.append(...kids);
    return e;
  }
  function button(cls, kids, title, onClick) {
    const b = el("button", `${cls} hit zpc-no-drag`, ...kids);
    b.title = title;
    b.addEventListener("click", e => {
      e.stopPropagation();
      onClick(e);
    });
    b.addEventListener("mousedown", e => e.stopPropagation());
    return b;
  }

  // --- Firefox player plumbing -----------------------------------------------------------
  const player = (() => {
    try {
      // eslint-disable-next-line no-undef
      return Player;
    } catch {
      return null;
    }
  })();
  if (!player) {
    console.warn("[zen-pip-arc-controls] Firefox Player not found; leaving stock controls");
    return;
  }
  const nativeClick = id => doc.getElementById(id)?.click();
  const originBrowser = () => {
    try {
      // eslint-disable-next-line no-undef
      return PictureInPicture.weakWinToBrowser.get(win) ?? null;
    } catch {
      return null;
    }
  };

  // Zen's sidebar mini player mutes the tab, while Firefox's PiP mutes the <video>. Use the
  // tab mute so both controls agree, and also lift a video-level mute so sound really returns.
  const isMuted = () => !!originBrowser()?.audioMuted || !!player.isMuted;
  function toggleMute() {
    const browser = originBrowser();
    const chromeWin = browser?.documentGlobal ?? browser?.ownerGlobal;
    const tab = chromeWin?.gBrowser?.getTabForBrowser(browser);
    if (!tab) {
      player.toggleMute();
      return;
    }
    if (isMuted()) {
      if (browser.audioMuted) tab.toggleMuteAudio();
      if (player.isMuted) player.toggleMute();
    } else {
      tab.toggleMuteAudio();
    }
    // Zen only refreshes its cards' mute icon on its own clicks and on playback start/stop.
    try {
      chromeWin.gZenMediaController?.onAudioPlaybackStopped();
    } catch {}
  }

  // --- Build ------------------------------------------------------------------------------
  win.windowUtils.loadSheetUsingURIString(
    `data:text/css,${encodeURIComponent(CSS)}`,
    win.windowUtils.AUTHOR_SHEET
  );

  const title = el("div", "title");
  const pauseIcon = ICONS.pause();
  const playIcon = ICONS.play();
  const playButton = button("play", [pauseIcon, playIcon], "Pause", () => {
    nativeClick("playpause");
    win.setTimeout(sync, 60);
  });
  const skipButton = forward => {
    const b = button(`skip ${forward ? "fwd" : "back"}`, [ICONS.skip(forward)],
      forward ? "Skip ahead 15 seconds" : "Skip back 15 seconds", () => {
        for (let i = 0; i < SEEK_STEPS; i++) nativeClick(forward ? "seekForward" : "seekBackward");
        b.classList.add(forward ? "spin-fwd" : "spin-back");
        win.setTimeout(() => b.classList.remove("spin-fwd", "spin-back"), 250);
      });
    return b;
  };
  const fill = el("div", "fill");
  const track = el("div", "track", fill);
  const timeline = el("div", "timeline hit zpc-no-drag", track);
  const hint = el("div", "hint");
  const soundOnIcon = ICONS.speaker();
  const soundOffIcon = ICONS.speakerOff();
  const soundButton = button("pill sound", [soundOnIcon, soundOffIcon], "Mute", () => {
    toggleMute();
    win.setTimeout(sync, 60);
  });

  const root = el("div", "",
    el("div", "scrim"),
    el("div", "layer shadow",
      el("div", "top",
        el("div", "group", button("pill back", [ICONS.back(), el("span", "label", "Back to Tab")], "Back to Tab", () => nativeClick("unpip"))),
        title,
        el("div", "group",
          button("pill", [ICONS.minus(), el("span", "label", "Minimize")], "Minimize", () => nativeClick("minimize")),
          button("pill", [ICONS.xmark(), el("span", "label", "Close")], "Close", () => nativeClick("close")),
        ),
      ),
      el("div", "center", skipButton(false), playButton, skipButton(true)),
      hint,
      timeline,
      soundButton,
    ),
    el("div", "edge"),
  );
  root.id = "zpc";
  doc.body.append(root);

  // --- State sync -------------------------------------------------------------------------
  let shownPlaying = null;
  let shownMuted = null;
  let scrubFraction = null;
  function sizeClass() {
    const w = win.innerWidth;
    return SIZE_CLASS_BREAKS.filter(b => w >= b).length;
  }
  function setFill(fraction) {
    const width = track.clientWidth;
    fill.style.width = `${4 + Math.max(0, width - 4) * Math.max(0, Math.min(1, fraction))}px`;
  }
  function sync() {
    const playing = !!player.isPlaying;
    if (playing !== shownPlaying) {
      shownPlaying = playing;
      pauseIcon.classList.toggle("off", !playing);
      playIcon.classList.toggle("off", playing);
      playButton.title = playing ? "Pause" : "Play";
    }
    const muted = isMuted();
    if (muted !== shownMuted) {
      shownMuted = muted;
      soundOnIcon.classList.toggle("off", muted);
      soundOffIcon.classList.toggle("off", !muted);
      soundButton.title = muted ? "Unmute" : "Mute";
    }
    const scrubber = doc.getElementById("scrubber");
    const hasTimeline = !!scrubber && !scrubber.hidden;
    root.toggleAttribute("data-no-timeline", !hasTimeline);
    if (hasTimeline) setFill(scrubFraction ?? (Number(scrubber.value) || 0));
    const browser = originBrowser();
    const text = browser?.currentURI?.host || browser?.contentTitle || "";
    if (title.textContent !== text) title.textContent = text;
    root.dataset.class = String(sizeClass());
  }

  // --- Timeline: click or drag to seek; drag upward for precision (Arc) ------------------
  let scrub = null;
  timeline.addEventListener("pointerdown", e => {
    if (e.button !== 0) return;
    e.stopPropagation();
    timeline.setPointerCapture(e.pointerId);
    timeline.setAttribute("data-scrubbing", "");
    const r = track.getBoundingClientRect();
    const start = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    scrub = { x: e.clientX, y: e.clientY, start, width: r.width };
    scrubFraction = start;
    setFill(start);
    hint.textContent = "Drag upwards to seek precisely";
    hint.setAttribute("data-on", "");
  });
  timeline.addEventListener("pointermove", e => {
    if (!scrub) return;
    const precision = Math.min(MAX_PRECISION, Math.max(1, Math.trunc((scrub.y - e.clientY) / PRECISION_PX)));
    scrubFraction = Math.max(0, Math.min(1, scrub.start + (e.clientX - scrub.x) / scrub.width / precision));
    setFill(scrubFraction);
    hint.textContent = precision > 1 ? `Seeking at ${precision}× precision` : "Drag upwards to seek precisely";
  });
  const endScrub = () => {
    if (!scrub) return;
    timeline.removeAttribute("data-scrubbing");
    hint.removeAttribute("data-on");
    player.setVideoTime(scrubFraction);
    scrub = null;
    win.setTimeout(() => {
      scrubFraction = null;
      sync();
    }, 150);
  };
  timeline.addEventListener("pointerup", endScrub);
  timeline.addEventListener("lostpointercapture", endScrub);
  timeline.addEventListener("mousedown", e => e.stopPropagation());

  // --- Right-click menu: Arc puts Mute here (we also add an overlay button) ----------------------
  const menu = doc.createElementNS(XUL, "menupopup");
  const muteItem = doc.createElementNS(XUL, "menuitem");
  const copyItem = doc.createElementNS(XUL, "menuitem");
  copyItem.setAttribute("label", "Copy URL");
  muteItem.addEventListener("command", () => {
    toggleMute();
    win.setTimeout(sync, 60);
  });
  copyItem.addEventListener("command", () => {
    const url = originBrowser()?.currentURI?.spec;
    if (url) Cc["@mozilla.org/widget/clipboardhelper;1"].getService(Ci.nsIClipboardHelper).copyString(url);
  });
  menu.append(muteItem, copyItem);
  (doc.querySelector("body") ?? doc.documentElement).append(menu);
  win.addEventListener("contextmenu", e => {
    muteItem.setAttribute("label", isMuted() ? "Unmute" : "Mute");
    menu.openPopupAtScreen(e.screenX, e.screenY, true);
  });

  // --- Show / hide like Arc ---------------------------------------------------------------
  let hideTimer = 0;
  let lastHidden = null; // pointer position when the controls were last hidden
  let lastPointer = null;
  const busy = () => !!scrub;
  function show() {
    root.setAttribute("data-visible", "");
    root.removeAttribute("data-hidden-cursor");
    win.clearTimeout(hideTimer);
    hideTimer = win.setTimeout(() => hide(true), HIDE_AFTER_MS);
  }
  function hide(fromIdle) {
    win.clearTimeout(hideTimer);
    if (busy()) return;
    root.removeAttribute("data-visible");
    // Arc hides the pointer when the controls time out over the video.
    root.toggleAttribute("data-hidden-cursor", !!fromIdle);
    lastHidden = lastPointer;
  }
  doc.addEventListener("mousemove", e => {
    const p = { x: e.screenX, y: e.screenY };
    lastPointer = p;
    if (!root.hasAttribute("data-visible") && lastHidden &&
        Math.hypot(p.x - lastHidden.x, p.y - lastHidden.y) <= SHOW_AFTER_MOVE_PT) {
      return;
    }
    show();
  });
  doc.addEventListener("mousedown", () => show(), true);
  doc.documentElement.addEventListener("mouseleave", () => {
    win.clearTimeout(hideTimer);
    if (!busy()) {
      root.removeAttribute("data-visible");
      root.removeAttribute("data-hidden-cursor");
      lastHidden = null;
    }
  });
  win.addEventListener("resize", sync);

  const syncTimer = win.setInterval(sync, 250);
  win.addEventListener("unload", () => {
    win.clearInterval(syncTimer);
    win.clearTimeout(hideTimer);
  });
  sync();
})(window);
