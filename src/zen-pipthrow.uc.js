// ==UserScript==
// @name           Zen PiP Throw
// @description    Arc's Picture-in-Picture window physics: drag or two-finger-scroll it, throw it into a corner.
// @include        chrome://global/content/pictureinpicture/player.xhtml
// ==/UserScript==

// Runs inside the PiP player window itself (one instance per PiP window), so it can see
// player.js's global `Player` and every PiP window gets its own independent state.
//
// The motion model follows Arc's mini player:
//  - Release is "thrown" above a speed threshold. A thrown window flies with its release
//    velocity, stops against the screen edge it hits, then slides into the corner whose
//    direction from the window centre best matches the throw. Not thrown: it stays where
//    it is, pushed back on-screen.
//  - Each axis is an analytic damped spring (response 0.9s, damping ratio 0.9).
//  - Corners sit 10pt inside the visible area (menu bar / Dock excluded) of the screen the
//    window is on.
//  - Two-finger scroll over the window drags it 1:1 with the fingers; lifting the fingers
//    with speed throws it.
//
// macOS facts specific to Gecko (measured):
//  - The PiP mouse drag is a native window drag. window.screenX/Y and event.screenX/Y stay
//    at the pre-drag position until after mouseup, so the real cursor (CoreGraphics) is
//    the source of truth for position and velocity.
(function zenPipThrow(win) {
  "use strict";

  if (win.__zenPipThrow) return;
  win.__zenPipThrow = true;

  const PREF = "zen.pipthrow.";
  const DEFAULTS = {
    enabled: true,
    // Release speed (pt/s, mouse or trackpad) above which the window is thrown to a corner
    // (Arc: 350). Low, so anything but a deliberate stop goes to a corner.
    minVelocity: 120,
    // Spring response (ms) and damping ratio x100. Arc: 900 / 90.
    responseMs: 900,
    dampingPct: 90,
    // Cap (pt/s) on the speed carried into the glide, so mouse throws (often 4000-9000 pt/s)
    // glide like trackpad throws (~1000-1500). 0 = uncapped.
    maxThrowVelocity: 1500,
    // Inset from the screen's visible area (menu bar / Dock excluded). Arc: 10.
    margin: 10,
    // Hover + two-finger scroll (Magic Mouse / trackpad) drags the window.
    swipe: true,
    // Flip if scroll-dragging goes the opposite way to your fingers.
    swipeInvert: false,
    debug: false,
  };

  // Corner choice is Arc's: the screen corner whose direction from the window centre best
  // matches the throw direction. Differences from Arc: the direction comes from velocity
  // smoothed over ~60ms (Arc reads one finger delta, which jitters on trackpads), and there
  // is no 45-degree cutoff, so a throw always ends in a corner.
  const SETTLE_PT = 0.5; // finish once within half a point and nearly still (no 1px crawl)

  const prefs = Services.prefs;
  const getPref = key => {
    const name = PREF + key;
    const def = DEFAULTS[key];
    try {
      return typeof def === "boolean" ? prefs.getBoolPref(name, def) : prefs.getIntPref(name, def);
    } catch {
      return def;
    }
  };
  // Seed defaults on the default branch so the prefs show up in about:config.
  const defaults = prefs.getDefaultBranch(PREF);
  for (const [key, value] of Object.entries(DEFAULTS)) {
    try {
      if (typeof value === "boolean") defaults.setBoolPref(key, value);
      else defaults.setIntPref(key, value);
    } catch {}
  }

  // Debug output goes to <profile>/zen-pipthrow.log, buffered and flushed when idle so logging
  // never stalls a drag or a throw (per-event file writes + console output caused hitches).
  const LOG_FILE = PathUtils.join(PathUtils.profileDir, "zen-pipthrow.log");
  let logBuffer = [];
  let logFlushScheduled = false;
  const flushLog = () => {
    logFlushScheduled = false;
    const text = logBuffer.join("");
    logBuffer = [];
    if (text) IOUtils.writeUTF8(LOG_FILE, text, { mode: "appendOrCreate" }).catch(() => {});
  };
  const log = (...args) => {
    if (!getPref("debug")) return;
    logBuffer.push(`${win.performance.now().toFixed(1)} ${args.map(a => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}\n`);
    if (!logFlushScheduled) {
      logFlushScheduled = true;
      win.setTimeout(() => win.requestIdleCallback(flushLog, { timeout: 2000 }), 1000);
    }
  };

  // --- macOS natives (js-ctypes) ---------------------------------------------------------
  const ctypesLib = (() => {
    try {
      return ChromeUtils.importESModule("resource://gre/modules/ctypes.sys.mjs").ctypes;
    } catch {
      return null;
    }
  })();

  // Cursor position / warp (CoreGraphics) and "hide cursor until the mouse moves" (AppKit).
  const natives = (() => {
    if (AppConstants.platform !== "macosx" || !ctypesLib) return null;
    const ctypes = ctypesLib;
    try {
      const cg = ctypes.open("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics");
      const cf = ctypes.open("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation");
      const objc = ctypes.open("/usr/lib/libobjc.A.dylib");
      const CGPoint = new ctypes.StructType("CGPoint", [{ x: ctypes.double }, { y: ctypes.double }]);
      const CGEventCreate = cg.declare("CGEventCreate", ctypes.default_abi, ctypes.voidptr_t, ctypes.voidptr_t);
      const CGEventGetLocation = cg.declare("CGEventGetLocation", ctypes.default_abi, CGPoint, ctypes.voidptr_t);
      const CGWarpMouseCursorPosition = cg.declare("CGWarpMouseCursorPosition", ctypes.default_abi,
        ctypes.int32_t, CGPoint);
      const CGAssociateMouseAndMouseCursorPosition = cg.declare("CGAssociateMouseAndMouseCursorPosition",
        ctypes.default_abi, ctypes.int32_t, ctypes.uint32_t);
      const CFRelease = cf.declare("CFRelease", ctypes.default_abi, ctypes.void_t, ctypes.voidptr_t);
      const CGEventSourceButtonState = cg.declare("CGEventSourceButtonState", ctypes.default_abi,
        ctypes.bool, ctypes.int32_t, ctypes.uint32_t);
      const objc_getClass = objc.declare("objc_getClass", ctypes.default_abi, ctypes.voidptr_t, ctypes.char.ptr);
      const sel_registerName = objc.declare("sel_registerName", ctypes.default_abi, ctypes.voidptr_t, ctypes.char.ptr);
      // arm64 objc_msgSend must be called through the exact (non-variadic) prototype.
      const msgSendBool = objc.declare("objc_msgSend", ctypes.default_abi,
        ctypes.voidptr_t, ctypes.voidptr_t, ctypes.voidptr_t, ctypes.signed_char);
      const msgSendId = objc.declare("objc_msgSend", ctypes.default_abi,
        ctypes.voidptr_t, ctypes.voidptr_t, ctypes.voidptr_t);
      const msgSendU64 = objc.declare("objc_msgSend", ctypes.default_abi,
        ctypes.uint64_t, ctypes.voidptr_t, ctypes.voidptr_t);
      const msgSendDouble = objc.declare("objc_msgSend", ctypes.default_abi,
        ctypes.double, ctypes.voidptr_t, ctypes.voidptr_t);
      const msgSendBoolRet = objc.declare("objc_msgSend", ctypes.default_abi,
        ctypes.signed_char, ctypes.voidptr_t, ctypes.voidptr_t);
      const NSCursor = objc_getClass("NSCursor");
      const setHiddenUntilMouseMoves = sel_registerName("setHiddenUntilMouseMoves:");
      const NSApp = msgSendId(objc_getClass("NSApplication"), sel_registerName("sharedApplication"));
      const SEL = Object.fromEntries(
        ["currentEvent", "type", "phase", "momentumPhase", "scrollingDeltaX", "scrollingDeltaY",
          "hasPreciseScrollingDeltas", "isDirectionInvertedFromDevice"].map(n => [n, sel_registerName(n)])
      );
      const NSEventTypeScrollWheel = 22;
      win.addEventListener("unload", () => {
        cg.close();
        cf.close();
        objc.close();
      });
      return {
        cursor() {
          const ev = CGEventCreate(null);
          if (ev.isNull()) return null;
          const p = CGEventGetLocation(ev);
          CFRelease(ev);
          return { x: p.x, y: p.y };
        },
        // Is the left button physically down right now (combined session state)?
        leftButtonDown() {
          return CGEventSourceButtonState(0, 0);
        },
        warp(x, y) {
          CGWarpMouseCursorPosition(new CGPoint(x, y));
          // A warp otherwise freezes real mouse input for ~250ms.
          CGAssociateMouseAndMouseCursorPosition(1);
        },
        hideCursorUntilMouseMoves() {
          if (!NSCursor.isNull()) msgSendBool(NSCursor, setHiddenUntilMouseMoves, 1);
        },
        // The NSEvent behind the DOM wheel event currently being dispatched (Gecko dispatches
        // wheel events synchronously from -scrollWheel:), with the fields Arc's handler reads.
        currentScrollEvent() {
          const ev = msgSendId(NSApp, SEL.currentEvent);
          if (ev.isNull() || Number(msgSendU64(ev, SEL.type)) !== NSEventTypeScrollWheel) return null;
          return {
            phase: Number(msgSendU64(ev, SEL.phase)),
            momentumPhase: Number(msgSendU64(ev, SEL.momentumPhase)),
            dx: msgSendDouble(ev, SEL.scrollingDeltaX),
            dy: msgSendDouble(ev, SEL.scrollingDeltaY),
            precise: msgSendBoolRet(ev, SEL.hasPreciseScrollingDeltas) !== 0,
            inverted: msgSendBoolRet(ev, SEL.isDirectionInvertedFromDevice) !== 0,
          };
        },
      };
    } catch (e) {
      console.warn("[zen-pipthrow] macOS natives unavailable, using DOM events only", e);
      return null;
    }
  })();
  const cursor = natives?.cursor ?? null;

  // macOS "natural scrolling" (com.apple.swipescrolldirection). With it on, a finger moving
  // right produces a negative deltaX, so the finger direction is the negated scroll delta.
  const naturalScrolling = (() => {
    if (AppConstants.platform !== "macosx" || !ctypesLib) return true;
    const ctypes = ctypesLib;
    try {
      const cf = ctypes.open("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation");
      try {
        const kCFStringEncodingUTF8 = 0x08000100;
        const CFStringCreateWithCString = cf.declare("CFStringCreateWithCString", ctypes.default_abi,
          ctypes.voidptr_t, ctypes.voidptr_t, ctypes.char.ptr, ctypes.uint32_t);
        const CFPreferencesGetAppBooleanValue = cf.declare("CFPreferencesGetAppBooleanValue", ctypes.default_abi,
          ctypes.unsigned_char, ctypes.voidptr_t, ctypes.voidptr_t, ctypes.unsigned_char.ptr);
        const CFRelease = cf.declare("CFRelease", ctypes.default_abi, ctypes.void_t, ctypes.voidptr_t);
        const key = CFStringCreateWithCString(null, "com.apple.swipescrolldirection", kCFStringEncodingUTF8);
        const app = CFStringCreateWithCString(null, ".GlobalPreferences", kCFStringEncodingUTF8);
        const valid = new ctypes.unsigned_char(0);
        const value = CFPreferencesGetAppBooleanValue(key, app, valid.address());
        CFRelease(key);
        CFRelease(app);
        return valid.value ? !!value : true; // macOS default is natural
      } finally {
        cf.close();
      }
    } catch (e) {
      console.warn("[zen-pipthrow] couldn't read scroll direction, assuming natural", e);
      return true;
    }
  })();

  // --- Shared state --------------------------------------------------------------------
  let drag = null; // mouse drag
  let sdrag = null; // scroll drag
  let anim = null;
  let handledLastMouseUp = false;

  const isInteractive = target =>
    target?.closest?.(".control-item, .box, .scrubber-no-drag, button, input, .panel, .zpc-no-drag");
  const isFullscreen = () => !!win.document.fullscreenElement;

  // Where the window really is: mid-animation, the spring's position; otherwise screenX/Y.
  const currentPos = () =>
    anim ? { x: anim.x, y: anim.y } : { x: win.screenX, y: win.screenY };

  // --- Mouse drag (native window drag) -------------------------------------------------
  const SAMPLE_WINDOW_MS = 100; // ring buffer span
  const VELOCITY_WINDOW_MS = 60; // velocity fitted over the last ~60ms
  // No movement for this long before the release = the user paused, then let go: no throw.
  // Measured against the true release (button state polled from macOS), because the DOM
  // mouseup after a native drag arrives a variable 60-150ms late.
  const STALE_MS = 50;
  const MOUSEUP_FALLBACK_STALE_MS = 150; // when the true release time isn't known
  const CLICK_SLOP_PX = 10;

  function pushSample(samples, x, y, t = win.performance.now()) {
    const last = samples[samples.length - 1];
    if (last && last.x === x && last.y === y) return;
    samples.push({ t, x, y });
    while (samples.length > 2 && t - samples[0].t > SAMPLE_WINDOW_MS) samples.shift();
  }

  // Event screenX/Y after a native drag are computed from the window's pre-drag position,
  // so they read as "didn't move". The real cursor is the source of truth when we have it.
  const pointerPosition = e => cursor?.() ?? { x: e.screenX, y: e.screenY };

  function onMouseDown(e) {
    stopAnimation();
    drag = null;
    if (e.button !== 0 || !getPref("enabled") || isFullscreen() || isInteractive(e.target)) return;
    const start = pointerPosition(e);
    drag = {
      startWinX: win.screenX,
      startWinY: win.screenY,
      startX: start.x,
      startY: start.y,
      samples: [],
      poll: 0,
      releaseT: null, // true release time, from polling the button state
    };
    pushSample(drag.samples, start.x, start.y);
    if (cursor) {
      drag.poll = win.setInterval(() => {
        if (!drag || drag.releaseT !== null) return;
        if (natives && !natives.leftButtonDown()) {
          drag.releaseT = win.performance.now(); // released: stop sampling here
          return;
        }
        const p = cursor();
        if (p) pushSample(drag.samples, p.x, p.y);
      }, 8);
    }
  }

  function onMouseMove(e) {
    // With the CoreGraphics poll running, DOM coords (half-pixel, different timing) would
    // only add jitter to the velocity estimate.
    if (drag && !cursor && e.buttons & 1) pushSample(drag.samples, e.screenX, e.screenY);
  }

  function endDrag() {
    if (drag?.poll) win.clearInterval(drag.poll);
    const d = drag;
    drag = null;
    return d;
  }

  // Least-squares slope of position over the last VELOCITY_WINDOW_MS: robust to the jitter
  // of 8ms cursor polling, where a two-point difference can even point the wrong way.
  function sampleVelocity(samples, now, staleMs = STALE_MS) {
    const last = samples[samples.length - 1];
    if (!last || now - last.t > staleMs) return { vx: 0, vy: 0 };
    const recent = samples.filter(s => last.t - s.t <= VELOCITY_WINDOW_MS);
    if (recent.length < 2 || last.t - recent[0].t < 8) return { vx: 0, vy: 0 };
    const n = recent.length;
    const mt = recent.reduce((a, s) => a + s.t, 0) / n;
    const mx = recent.reduce((a, s) => a + s.x, 0) / n;
    const my = recent.reduce((a, s) => a + s.y, 0) / n;
    let stt = 0, stx = 0, sty = 0;
    for (const s of recent) {
      const dt = s.t - mt;
      stt += dt * dt;
      stx += dt * (s.x - mx);
      sty += dt * (s.y - my);
    }
    return { vx: (stx / stt) * 1000, vy: (sty / stt) * 1000 }; // pt/s
  }

  function onMouseUp(e) {
    handledLastMouseUp = false;
    const d = endDrag();
    if (!d || e.button !== 0 || !getPref("enabled") || isFullscreen()) return;

    const end = pointerPosition(e);
    const dx = end.x - d.startX;
    const dy = end.y - d.startY;
    if (Math.hypot(dx, dy) < CLICK_SLOP_PX) return; // a click on the video/controls

    handledLastMouseUp = true;
    const v = d.releaseT !== null
      ? sampleVelocity(d.samples, d.releaseT)
      : sampleVelocity(d.samples, win.performance.now(), MOUSEUP_FALLBACK_STALE_MS);
    const thrown = Math.hypot(v.vx, v.vy) > getPref("minVelocity");
    const pos = { x: d.startWinX + dx, y: d.startWinY + dy };
    const grab = { x: d.startX - d.startWinX, y: d.startY - d.startWinY };
    log("mouse release", { dx, dy, ...v, thrown });
    // Start after the native drag has fully finished so the window manager doesn't fight us.
    // Glide from where macOS actually left the window once it reports it; the cursor keeps
    // moving a little after the button is released, so the computed `pos` can overshoot.
    win.requestAnimationFrame(() => {
      const moved = win.screenX !== d.startWinX || win.screenY !== d.startWinY;
      release(pos, grab, v, thrown, moved ? { x: win.screenX, y: win.screenY } : pos);
    });
  }

  // --- Two-finger scroll drag (Magic Mouse / trackpad) ---------------------------------
  // Arc's handler, driven by the real NSEvent (read via currentScrollEvent()):
  //  - only precise (trackpad / Magic Mouse) scrolls, never with Cmd held;
  //  - finger events (no momentum phase) move the window 1:1 by scrollingDelta;
  //  - momentum events never move it. The first one means the fingers lifted while moving:
  //    release with the finger velocity (smoothed over the last ~60ms), thrown above minVelocity;
  //  - fingers that stop and lift produce no momentum: after a short silence the drag ends
  //    unthrown (window stays). Moving again simply grabs it again.
  // Gecko doesn't dispatch the zero-delta began/ended events, hence the silence timer.
  const SCROLL_REST_MS = 80; // finger silence after which the drag ends unthrown...
  // ...unless the fingers were still moving: macOS can deliver "momentum began" well after
  // the last finger event, so a moving release waits this much longer for it.
  const MOMENTUM_WAIT_MS = 300;
  const PHASE_NONE = 0;
  // Finger velocity = mean of the last few finger deltas x 90 pt/s (Arc uses its single last
  // delta x 90; a short mean keeps one zigzagging trackpad delta from steering the throw).
  // No timestamps: real trackpad events can share near-identical times, which made a
  // time-based slope explode.
  const VELOCITY_DELTAS = 4;
  const DELTA_TO_VELOCITY = 90;

  function onWheel(e) {
    if (!getPref("enabled") || !getPref("swipe") || isFullscreen() || drag) return;
    if (e.ctrlKey || e.metaKey) return; // pinch-zoom / Arc's Cmd+scroll is resize, not drag
    const ns = natives?.currentScrollEvent();
    // Arc only drags on finger gestures (trackpad / Magic Mouse): precise deltas AND a gesture
    // or momentum phase. Mouse wheels, including "smooth scrolling" Logitech wheels that send
    // precise deltas, carry no phase and must never move the window.
    if (ns && (!ns.precise || (ns.phase === PHASE_NONE && ns.momentumPhase === PHASE_NONE))) return;
    e.preventDefault();
    const now = win.performance.now();

    if (ns && ns.momentumPhase !== PHASE_NONE) {
      // Momentum: fingers are off. Never moves the window; the first one ends a live drag.
      if (sdrag && !sdrag.ended) endScrollDrag(sdrag, "lift");
      return;
    }

    let d;
    if (ns) {
      // Arc: the window follows the fingers. Inverted (natural) devices report deltas in
      // finger direction already; otherwise flip.
      const k = (ns.inverted ? 1 : -1) * (getPref("swipeInvert") ? -1 : 1);
      d = { x: k * ns.dx, y: k * ns.dy };
    } else {
      // No AppKit access: fall back to the DOM deltas.
      const scale = e.deltaMode === e.DOM_DELTA_LINE ? 16 : e.deltaMode === e.DOM_DELTA_PAGE ? 400 : 1;
      const sign = (naturalScrolling ? -1 : 1) * (getPref("swipeInvert") ? -1 : 1);
      d = { x: sign * e.deltaX * scale, y: sign * e.deltaY * scale };
    }
    if (d.x === 0 && d.y === 0) return;

    if (!sdrag || sdrag.ended) startScrollDrag(now);
    const s = sdrag;
    s.last = now;
    log("wheel", { dx: d.x, dy: d.y, phase: ns?.phase });
    applyScrollDelta(s, d);
    win.clearTimeout(s.restTimer);
    s.restTimer = win.setTimeout(() => {
      if (sdrag !== s || s.ended) return;
      const fv = fingerVelocity(s);
      if (Math.hypot(fv.vx, fv.vy) <= getPref("minVelocity")) {
        endScrollDrag(s, "rest");
        return;
      }
      s.restTimer = win.setTimeout(() => {
        if (sdrag === s && !s.ended) endScrollDrag(s, "rest");
      }, MOMENTUM_WAIT_MS);
    }, SCROLL_REST_MS);
  }

  function startScrollDrag(now) {
    const from = currentPos();
    stopAnimation();
    if (sdrag?.raf) win.cancelAnimationFrame(sdrag.raf);
    const c = cursor?.();
    sdrag = {
      x: from.x,
      y: from.y,
      grab: c ? { x: c.x - from.x, y: c.y - from.y } : { x: win.outerWidth / 2, y: win.outerHeight / 2 },
      haveCursor: !!c,
      start: now,
      last: now,
      deltas: [],
      restTimer: 0,
      ended: false,
      raf: 0,
    };
    natives?.hideCursorUntilMouseMoves();
    log("scroll grab", { from });
  }

  function applyScrollDelta(s, d) {
    s.x += d.x;
    s.y += d.y;
    // Arc: hard clamp into the visible screen area, inset by the margin.
    const area = visibleRectAt(s.x + s.grab.x, s.y + s.grab.y);
    const m = getPref("margin");
    const w = win.outerWidth;
    const h = win.outerHeight;
    s.x = clamp(s.x, area.left + m, area.left + area.width - w - m);
    s.y = clamp(s.y, area.top + m, area.top + area.height - h - m);
    s.deltas.push(d);
    if (s.deltas.length > VELOCITY_DELTAS) s.deltas.shift();
    // Exactly under the fingers, no easing: one window move (and cursor move) per frame.
    if (!s.raf) s.raf = win.requestAnimationFrame(() => renderScrollDrag(s));
  }

  function renderScrollDrag(s) {
    s.raf = 0;
    if (sdrag !== s || s.ended) return;
    win.moveTo(Math.round(s.x), Math.round(s.y));
    // Keep the pointer over the window so the next scroll events still reach it.
    if (s.haveCursor) natives?.warp(s.x + s.grab.x, s.y + s.grab.y);
  }

  function fingerVelocity(s) {
    if (!s.deltas.length) return { vx: 0, vy: 0 };
    const n = s.deltas.length;
    const mx = s.deltas.reduce((a, d) => a + d.x, 0) / n;
    const my = s.deltas.reduce((a, d) => a + d.y, 0) / n;
    return { vx: mx * DELTA_TO_VELOCITY, vy: my * DELTA_TO_VELOCITY };
  }

  function endScrollDrag(s, why) {
    s.ended = true;
    win.clearTimeout(s.restTimer);
    win.cancelAnimationFrame(s.raf);
    win.moveTo(Math.round(s.x), Math.round(s.y)); // apply any not-yet-rendered finger movement
    // Only a lift (momentum began) can throw; fingers that went still don't.
    const fv = fingerVelocity(s);
    const thrown = why === "lift" && Math.hypot(fv.vx, fv.vy) > getPref("minVelocity");
    const v = thrown ? fv : { vx: 0, vy: 0 };
    log("scroll release", { why, ...fv, thrown });
    // Arc also warps the (hidden) pointer to the landing spot here; with a visible pointer
    // that reads as a jump, so the pointer is left where the fingers left it.
    release({ x: s.x, y: s.y }, s.grab, v, thrown);
  }

  // --- Release: Arc's target choice ----------------------------------------------------
  const screenManager = Cc["@mozilla.org/gfx/screenmanager;1"].getService(Ci.nsIScreenManager);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, Math.max(lo, hi)));

  function rectOf(screen, visible) {
    const l = {}, t = {}, w = {}, h = {};
    if (visible) screen.GetAvailRectDisplayPix(l, t, w, h);
    else screen.GetRectDisplayPix(l, t, w, h);
    return { left: l.value, top: t.value, width: w.value, height: h.value };
  }

  const screenAt = (x, y) => screenManager.screenForRect(x - 1, y - 1, 2, 2);
  const visibleRectAt = (x, y) => rectOf(screenAt(x, y), true);

  // pos: window top-left; grab: grab point inside the window; v: pt/s; from: where the window
  // is drawn right now (defaults to pos). Returns the target top-left it animates to.
  function release(pos, grab, v, thrown, from = pos) {
    const w = win.outerWidth;
    const h = win.outerHeight;
    // Arc's default anchor (0.5, 0.5): the window centre, so a throw behaves the same
    // wherever the window was grabbed.
    const p = { x: pos.x + w / 2, y: pos.y + h / 2 };
    const screen = screenAt(p.x, p.y);
    const full = rectOf(screen, false);
    const visible = rectOf(screen, true);
    const m = getPref("margin");

    let target = null;
    if (thrown) {
      const throwAngle = Math.atan2(v.vy, v.vx);
      let best = null;
      for (const c of [
        { top: true, left: true, x: full.left, y: full.top },
        { top: true, left: false, x: full.left + full.width, y: full.top },
        { top: false, left: true, x: full.left, y: full.top + full.height },
        { top: false, left: false, x: full.left + full.width, y: full.top + full.height },
      ]) {
        let diff = Math.abs(Math.atan2(c.y - p.y, c.x - p.x) - throwAngle) % (2 * Math.PI);
        if (diff > Math.PI) diff = 2 * Math.PI - diff;
        if (!best || diff < best.diff) best = { ...c, diff };
      }
      const { left, top } = best;
      target = {
        x: Math.round(left ? visible.left + m : visible.left + visible.width - w - m),
        y: Math.round(top ? visible.top + m : visible.top + visible.height - h - m),
      };
      log("corner", { v, p, offByDeg: Math.round((best.diff * 180) / Math.PI), corner: (top ? "T" : "B") + (left ? "L" : "R") });
    }
    if (!target) {
      // Stay where it was released, pushed back inside the visible area.
      target = {
        x: Math.round(clamp(from.x, visible.left + m, visible.left + visible.width - w - m)),
        y: Math.round(clamp(from.y, visible.top + m, visible.top + visible.height - h - m)),
      };
    }
    let vel = thrown ? v : { vx: 0, vy: 0 };
    const cap = getPref("maxThrowVelocity");
    const speed = Math.hypot(vel.vx, vel.vy);
    if (cap > 0 && speed > cap) vel = { vx: (vel.vx * cap) / speed, vy: (vel.vy * cap) / speed };
    if (target.x === Math.round(from.x) && target.y === Math.round(from.y) && !thrown) {
      log("dropped", { pos });
      return target;
    }
    log("target", { thrown, target, v: vel });
    animateTo(target, vel, from, {
      minX: visible.left + m,
      maxX: Math.max(visible.left + m, visible.left + visible.width - w - m),
      minY: visible.top + m,
      maxY: Math.max(visible.top + m, visible.top + visible.height - h - m),
    });
    return target;
  }

  // --- Spring (analytic damped oscillator, like Arc's Motion library) -------------------
  // x(t) solved in closed form per axis, so the motion is exact at any frame rate.
  function springAxis(x0, target, v0, omega, zeta) {
    const a = x0 - target;
    if (zeta < 1) {
      const wd = omega * Math.sqrt(1 - zeta * zeta);
      const b = (v0 + zeta * omega * a) / wd;
      return t => {
        const e = Math.exp(-zeta * omega * t);
        const c = Math.cos(wd * t);
        const s = Math.sin(wd * t);
        return {
          x: target + e * (a * c + b * s),
          v: e * ((b * wd - zeta * omega * a) * c - (a * wd + zeta * omega * b) * s),
        };
      };
    }
    if (zeta === 1) {
      const b = v0 + omega * a;
      return t => {
        const e = Math.exp(-omega * t);
        return { x: target + e * (a + b * t), v: e * (b - omega * (a + b * t)) };
      };
    }
    const r = omega * Math.sqrt(zeta * zeta - 1);
    const r1 = -zeta * omega + r;
    const r2 = -zeta * omega - r;
    const c2 = (v0 - r1 * a) / (r2 - r1);
    const c1 = a - c2;
    return t => {
      const e1 = Math.exp(r1 * t);
      const e2 = Math.exp(r2 * t);
      return { x: target + c1 * e1 + c2 * e2, v: c1 * r1 * e1 + c2 * r2 * e2 };
    };
  }

  // `from` is where the window really is. After a native drag, window.screenX/Y can still
  // report the pre-drag position, which would launch the glide from the wrong place.
  // The throw keeps its full direction and speed; the spring pulls toward the corner over the
  // glide, and the screen edges (bounds) are walls: an axis that hits one stops dead there
  // ("slams into the edge") while the other keeps going ("slides into the corner"). Corners
  // sit on two edges, so excess speed thuds into an edge instead of overshooting the corner.
  function animateTo(target, v0, from, bounds) {
    stopAnimation();
    const response = Math.max(50, getPref("responseMs")) / 1000;
    const zeta = Math.max(0.1, getPref("dampingPct") / 100);
    const omega = (2 * Math.PI) / response;
    const t0 = win.performance.now();
    const axis = (p0, goal, v, lo, hi) => ({
      goal, lo, hi, t0, fn: springAxis(p0, goal, v, omega, zeta), p: p0, v,
    });
    const ax = axis(from.x, target.x, v0.vx, bounds?.minX ?? -Infinity, bounds?.maxX ?? Infinity);
    const ay = axis(from.y, target.y, v0.vy, bounds?.minY ?? -Infinity, bounds?.maxY ?? Infinity);
    const state = { x: from.x, y: from.y, raf: 0 };
    anim = state;

    const advance = (a, now) => {
      const r = a.fn((now - a.t0) / 1000);
      if (r.x < a.lo || r.x > a.hi) {
        // Hit the wall: stop this axis there, then let the spring settle it from rest.
        a.p = clamp(r.x, a.lo, a.hi);
        a.v = 0;
        a.fn = springAxis(a.p, a.goal, 0, omega, zeta);
        a.t0 = now;
      } else {
        a.p = r.x;
        a.v = r.v;
      }
    };

    const step = now => {
      if (anim !== state) return;
      advance(ax, now);
      advance(ay, now);
      state.x = ax.p;
      state.y = ay.p;
      const settled =
        Math.abs(ax.p - target.x) < SETTLE_PT &&
        Math.abs(ay.p - target.y) < SETTLE_PT &&
        Math.abs(ax.v) < 20 &&
        Math.abs(ay.v) < 20;
      if (settled) {
        win.moveTo(target.x, target.y);
        anim = null;
        log("settled", target);
        return;
      }
      win.moveTo(Math.round(ax.p), Math.round(ay.p));
      state.raf = win.requestAnimationFrame(step);
    };
    state.raf = win.requestAnimationFrame(step);
  }

  function stopAnimation() {
    if (anim) {
      win.cancelAnimationFrame(anim.raf);
      anim = null;
    }
  }

  // --- Neutralize Firefox's built-in Cmd+drag corner snapping -----------------------------
  // Player is a top-level `let` in player.js, visible here because we run in the same global.
  function patchPlayer() {
    let player;
    try {
      // eslint-disable-next-line no-undef
      player = Player;
    } catch {
      console.warn("[zen-pipthrow] Player not found; Firefox Cmd-snapping left untouched");
      return;
    }
    if (typeof player?.onMouseUp !== "function" || player.onMouseUp.__zenPipThrow) return;
    const original = player.onMouseUp;
    const wrapped = function (event) {
      if (handledLastMouseUp && getPref("enabled")) {
        // Keep its bookkeeping consistent, skip the snap.
        this.oldMouseUpWindowX = win.screenX;
        this.oldMouseUpWindowY = win.screenY;
        return;
      }
      return original.call(this, event);
    };
    wrapped.__zenPipThrow = true;
    player.onMouseUp = wrapped;
  }

  // Capture phase on the window: runs before Player's own (bubble) listeners.
  win.addEventListener("mousedown", onMouseDown, true);
  win.addEventListener("mousemove", onMouseMove, true);
  win.addEventListener("mouseup", onMouseUp, true);
  win.addEventListener("wheel", onWheel, { capture: true, passive: false });
  win.addEventListener("MozDOMFullscreen:Entered", () => {
    stopAnimation();
    endDrag();
  });
  win.addEventListener("unload", () => {
    stopAnimation();
    endDrag();
    flushLog();
  });
  patchPlayer();
  log("attached", { natives: !!natives, naturalScrolling });
})(window);
