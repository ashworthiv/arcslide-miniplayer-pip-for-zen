// Launches a throwaway Zen instance (temp profile, Marionette on), opens a real PiP window
// for a local test video, and exposes helpers to run chrome JS and synthesize mouse drags.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Marionette } from "./marionette";

const ZEN = "/Applications/Zen.app/Contents/MacOS/zen";
const HERE = import.meta.dir;
export const MOUSE = join(HERE, "mouse");
export const VIDEO_URL = `file://${resolve(HERE, "fixtures/video.html")}`;

export interface Rect { x: number; y: number; w: number; h: number }

export class ZenHarness {
  proc!: ReturnType<typeof Bun.spawn>;
  m!: Marionette;
  profile = "";

  async launch(port = 2829, extraPrefs: Record<string, unknown> = {}, setupProfile?: (dir: string) => void) {
    this.profile = mkdtempSync(join(tmpdir(), "zen-pipthrow-test-"));
    const prefs: Record<string, unknown> = {
      "marionette.port": port,
      "browser.shell.checkDefaultBrowser": false,
      "zen.welcome-screen.seen": true,
      "browser.aboutwelcome.enabled": false,
      "media.autoplay.default": 0,
      "media.videocontrols.picture-in-picture.video-toggle.enabled": true,
      "browser.sessionstore.resume_from_crash": false,
      "datareporting.policy.dataSubmissionEnabled": false,
      "toolkit.telemetry.reportingpolicy.firstRun": false,
      ...extraPrefs,
    };
    writeFileSync(
      join(this.profile, "user.js"),
      Object.entries(prefs).map(([k, v]) => `user_pref(${JSON.stringify(k)}, ${JSON.stringify(v)});`).join("\n"),
    );
    setupProfile?.(this.profile);
    this.proc = Bun.spawn([ZEN, "-no-remote", "-profile", this.profile, "--marionette", "-remote-allow-system-access"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    this.m = await Marionette.connect(port, 60_000);
    await this.m.send("WebDriver:NewSession", { capabilities: { alwaysMatch: { "moz:firefoxOptions": {} } } });
    await this.m.send("Marionette:SetContext", { value: "chrome" });
    // Wait for a usable browser window.
    await this.poll(() => this.m.chrome<boolean>(`return !!(window.gBrowser && gBrowser.selectedBrowser)`), 30_000);
  }

  chrome<T = unknown>(script: string, args: unknown[] = []) {
    return this.m.chrome<T>(script, args);
  }

  async poll<T>(fn: () => Promise<T>, timeoutMs = 15_000, every = 200): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    let last: unknown;
    for (;;) {
      try {
        const v = await fn();
        if (v) return v;
      } catch (e) {
        last = e;
      }
      if (Date.now() > deadline) throw new Error(`poll timed out${last ? `: ${last}` : ""}`);
      await Bun.sleep(every);
    }
  }

  /** Opens the test video in a new tab and toggles PiP on it. Returns the PiP window rect. */
  async openPip(url = VIDEO_URL): Promise<Rect> {
    const before = (await this.chrome<number>(
      `return [...Services.wm.getEnumerator("Toolkit:PictureInPicture")].length`,
    )) ?? 0;
    await this.chrome(
      `window.__pipTestTab = gBrowser.addTab(arguments[0], { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });`,
      [url],
    );
    // First-run pages (Zen's bundled extensions) can steal selection; keep re-selecting the
    // test tab and re-issuing the PiP command until a new player window shows up.
    await this.poll(async () => {
      await this.chrome(
        `gBrowser.selectedTab = window.__pipTestTab;
         if (gBrowser.selectedBrowser.currentURI.spec === arguments[0])
           document.getElementById("View:PictureInPicture").doCommand();`,
        [url],
      );
      await Bun.sleep(1000);
      return (await this.chrome<number>(`return [...Services.wm.getEnumerator("Toolkit:PictureInPicture")].length`)) > before;
    }, 20_000, 0);
    return this.poll(() => this.pipRect(before), 15_000);
  }

  async pipRect(index = 0): Promise<Rect | null> {
    return this.chrome<Rect | null>(
      `const wins = [...Services.wm.getEnumerator("Toolkit:PictureInPicture")]
         .filter(w => w.document.readyState === "complete");
       const w = wins[arguments[0]];
       return w ? { x: w.screenX, y: w.screenY, w: w.outerWidth, h: w.outerHeight } : null;`,
      [index],
    );
  }

  /** Real OS drag via CGEvent. */
  async drag(x0: number, y0: number, x1: number, y1: number, durMs: number, holdMs = 60, cmd = false) {
    const p = Bun.spawn([MOUSE, "drag", ...[x0, y0, x1, y1, durMs, holdMs].map(String), ...(cmd ? ["cmd"] : [])]);
    await p.exited;
  }

  async click(x: number, y: number) {
    await Bun.spawn([MOUSE, "click", String(x), String(y)]).exited;
  }

  async quit() {
    try {
      await this.m.send("Marionette:Quit", { flags: ["eForceQuit"] });
    } catch {}
    this.m?.close();
    setTimeout(() => this.proc?.kill(), 3000).unref?.();
    await this.proc?.exited;
  }
}
