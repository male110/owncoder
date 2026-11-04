export interface ShellFrame {
  sequence: number;
  cwd: string;
  line: string;
  cursor: number;
  active: boolean;
}

export const OSC_PREFIX = "\x1b]633;OwnCoder;";
const MAX_FRAME = 192 * 1024;

/** Streaming OSC filter. Unrelated terminal controls pass through untouched. */
export class ShellProtocol {
  private pending = "";
  private sequence = 0;
  private discarding = false;

  constructor(private readonly nonce: string, private readonly receive: (frame: ShellFrame) => void) {}

  push(chunk: string): string {
    this.pending += chunk;
    let output = "";
    for (;;) {
      if (this.discarding) {
        const bell = this.pending.indexOf("\x07");
        const st = this.pending.indexOf("\x1b\\");
        const end = bell < 0 ? st : st < 0 ? bell : Math.min(bell, st);
        if (end < 0) {
          this.pending = this.pending.endsWith("\x1b") ? "\x1b" : "";
          break;
        }
        this.pending = this.pending.slice(end + (end === st ? 2 : 1));
        this.discarding = false;
        continue;
      }
      const start = this.pending.indexOf(OSC_PREFIX);
      if (start < 0) {
        let keep = 0;
        for (let n = Math.min(OSC_PREFIX.length - 1, this.pending.length); n > 0; n--) {
          if (this.pending.endsWith(OSC_PREFIX.slice(0, n))) { keep = n; break; }
        }
        output += this.pending.slice(0, this.pending.length - keep);
        this.pending = this.pending.slice(this.pending.length - keep);
        break;
      }
      output += this.pending.slice(0, start);
      this.pending = this.pending.slice(start);
      const bell = this.pending.indexOf("\x07", OSC_PREFIX.length);
      const st = this.pending.indexOf("\x1b\\", OSC_PREFIX.length);
      const end = bell < 0 ? st : st < 0 ? bell : Math.min(bell, st);
      if (end < 0) {
        // A malformed oversized control must not retain unbounded terminal output.
        if (this.pending.length > MAX_FRAME) {
          this.discarding = true;
          this.pending = this.pending.endsWith("\x1b") ? "\x1b" : "";
        }
        break;
      }
      const payload = this.pending.slice(OSC_PREFIX.length, end);
      this.pending = this.pending.slice(end + (end === st ? 2 : 1));
      // Strip our namespace even when invalid; do not display auth tokens or JSON.
      if (payload.length > MAX_FRAME || !payload.startsWith(`${this.nonce};`)) continue;
      try {
        const encoded = payload.slice(this.nonce.length + 1);
        if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) continue;
        const frame: unknown = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
        if (!validFrame(frame) || frame.sequence <= this.sequence) continue;
        this.sequence = frame.sequence;
        this.receive(frame);
      } catch { /* Malformed/foreign frames are never authority. */ }
    }
    return output;
  }

  flush(): string {
    const output = this.discarding || this.pending.startsWith(OSC_PREFIX) ? "" : this.pending;
    this.pending = "";
    this.discarding = false;
    return output;
  }
}

function validFrame(value: unknown): value is ShellFrame {
  if (!value || typeof value !== "object") return false;
  const f = value as ShellFrame;
  return Number.isSafeInteger(f.sequence) && f.sequence > 0 &&
    typeof f.cwd === "string" && f.cwd.length <= 32768 && !/[\x00-\x1f]/.test(f.cwd) &&
    typeof f.line === "string" && f.line.length <= 32768 &&
    Number.isInteger(f.cursor) && f.cursor >= 0 && f.cursor <= f.line.length &&
    typeof f.active === "boolean";
}
