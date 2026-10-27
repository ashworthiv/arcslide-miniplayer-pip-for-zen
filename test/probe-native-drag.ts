// Step 0.3: what does Gecko see during a native (-moz-window-dragging) PiP drag on macOS?
// Records DOM mouse/pointer events, setInterval + rAF samples of window.screenX/Y, and the
// global cursor position (CoreGraphics via js-ctypes) while a real CGEvent throw happens.
import { ZenHarness } from "./harness";

const PROBE = `
  const win = [...Services.wm.getEnumerator("Toolkit:PictureInPicture")][0];
  const { ctypes } = ChromeUtils.importESModule("resource://gre/modules/ctypes.sys.mjs");
  const cg = ctypes.open("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics");
  const CGPoint = new ctypes.StructType("CGPoint", [{ x: ctypes.double }, { y: ctypes.double }]);
  const CGEventCreate = cg.declare("CGEventCreate", ctypes.default_abi, ctypes.voidptr_t, ctypes.voidptr_t);
  const CGEventGetLocation = cg.declare("CGEventGetLocation", ctypes.default_abi, CGPoint, ctypes.voidptr_t);
  const cf = ctypes.open("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation");
  const CFRelease = cf.declare("CFRelease", ctypes.default_abi, ctypes.void_t, ctypes.voidptr_t);
  const cursor = () => { const e = CGEventCreate(null); const p = CGEventGetLocation(e); CFRelease(e); return [p.x, p.y]; };

  const log = [];
  const t0 = win.performance.now();
  const rec = (kind, extra = {}) => log.push({ t: +(win.performance.now() - t0).toFixed(1), kind, sx: win.screenX, sy: win.screenY, ...extra });
  for (const type of ["mousedown", "mouseup", "mousemove", "pointerdown", "pointerup", "pointermove", "pointercancel", "draggableregionleftmousedown", "lostpointercapture"]) {
    win.addEventListener(type, e => rec(type, { target: e.target.id || e.target.className || e.target.localName, ex: e.screenX, ey: e.screenY, meta: e.metaKey }), true);
  }
  const iv = win.setInterval(() => { const [cx, cy] = cursor(); rec("iv", { cx, cy }); }, 4);
  const raf = () => { rec("raf"); win.__probeRaf = win.requestAnimationFrame(raf); };
  win.__probeRaf = win.requestAnimationFrame(raf);
  // Main browser window timer too, in case the PiP window's timers are throttled.
  const mainIv = setInterval(() => rec("mainiv"), 4);
  win.__probe = { log, stop() { win.clearInterval(iv); clearInterval(mainIv); win.cancelAnimationFrame(win.__probeRaf); } };
  return true;
`;

const h = new ZenHarness();
try {
  await h.launch();
  const r = await h.openPip();
  console.log("pip rect", r);
  await Bun.sleep(1200);
  await h.chrome(PROBE);
  const sx = r.x + r.w * 0.3, sy = r.y + r.h * 0.45;
  // Throw: hold 80ms, then 320px left + 60px up in 90ms (~3.6 px/ms) and release.
  await h.drag(sx, sy, sx - 320, sy - 60, 90, 80);
  await Bun.sleep(600);
  const log = await h.chrome<any[]>(`const w=[...Services.wm.getEnumerator("Toolkit:PictureInPicture")][0]; w.__probe.stop(); return w.__probe.log;`);
  const after = await h.pipRect();
  console.log("pip after", after);
  // Summaries
  const counts: Record<string, number> = {};
  for (const e of log) counts[e.kind] = (counts[e.kind] ?? 0) + 1;
  console.log("counts", counts);
  const interesting = log.filter(e => !["iv", "raf", "mainiv"].includes(e.kind));
  console.log("events", JSON.stringify(interesting, null, 0));
  const down = log.find(e => e.kind === "mousedown" || e.kind === "pointerdown")?.t ?? 0;
  const ivs = log.filter(e => e.kind === "iv" && e.t >= down - 20 && e.t <= down + 400);
  let prev = "";
  for (const e of ivs) {
    const s = `${e.sx},${e.sy} cur ${e.cx.toFixed(0)},${e.cy.toFixed(0)}`;
    if (s !== prev) console.log(e.t, s);
    prev = s;
  }
  const rafs = log.filter(e => e.kind === "raf" && e.t >= down - 20 && e.t <= down + 400);
  console.log("raf samples in window:", rafs.length, "distinct screenX:", new Set(rafs.map(e => e.sx)).size);
  const mains = log.filter(e => e.kind === "mainiv" && e.t >= down - 20 && e.t <= down + 400);
  console.log("main iv samples:", mains.length, "distinct screenX:", new Set(mains.map(e => e.sx)).size);
} finally {
  await h.quit();
}
