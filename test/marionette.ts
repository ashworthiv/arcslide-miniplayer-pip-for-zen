// Minimal Marionette client for driving a throwaway Zen instance from bun.
// Protocol: frames are `${byteLength}:${json}`; commands are [0, id, name, params],
// responses are [1, id, error, result].
import { connect, type Socket } from "node:net";

export class Marionette {
  private sock!: Socket;
  private buf = Buffer.alloc(0);
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private handshake!: Promise<void>;

  static async connect(port: number, timeoutMs = 30_000): Promise<Marionette> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        const m = new Marionette();
        await m.open(port);
        return m;
      } catch (err) {
        if (Date.now() > deadline) throw err;
        await Bun.sleep(300);
      }
    }
  }

  private open(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      let greeted: () => void;
      this.handshake = new Promise(r => (greeted = r));
      this.sock = connect(port, "127.0.0.1");
      this.sock.once("error", reject);
      this.sock.on("data", chunk => this.onData(chunk, greeted));
      this.sock.once("connect", () => this.handshake.then(resolve, reject));
    });
  }

  private onData(chunk: Buffer, greeted: () => void) {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      const colon = this.buf.indexOf(":");
      if (colon < 0) return;
      const len = Number(this.buf.subarray(0, colon).toString());
      if (this.buf.length < colon + 1 + len) return;
      const msg = JSON.parse(this.buf.subarray(colon + 1, colon + 1 + len).toString());
      this.buf = this.buf.subarray(colon + 1 + len);
      if (!Array.isArray(msg)) {
        greeted();
        continue;
      }
      const [, id, error, result] = msg;
      const p = this.pending.get(id);
      if (!p) continue;
      this.pending.delete(id);
      if (error) p.reject(new Error(`${error.error}: ${error.message}\n${error.stacktrace ?? ""}`));
      else p.resolve(result);
    }
  }

  send(name: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = this.nextId++;
    const body = Buffer.from(JSON.stringify([0, id, name, params]));
    this.sock.write(`${body.length}:`);
    this.sock.write(body);
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  /** Runs `script` (a function body) in the chrome context of the current browser window. */
  async chrome<T = unknown>(script: string, args: unknown[] = []): Promise<T> {
    const r = await this.send("WebDriver:ExecuteScript", { script, args });
    return r.value as T;
  }

  close() {
    this.sock.end();
  }
}
