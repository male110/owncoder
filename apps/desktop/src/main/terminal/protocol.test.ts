import { describe, expect, it } from "vitest";
import { OSC_PREFIX, ShellProtocol, type ShellFrame } from "./protocol";

const state: ShellFrame = { sequence: 1, cwd: "C:\\work", line: "git switch café", cursor: 15, active: true };
function frame(value: unknown = state, nonce = "secret", end = "\x07") {
  return OSC_PREFIX + nonce + ";" + Buffer.from(JSON.stringify(value)).toString("base64") + end;
}

describe("shell OSC protocol", () => {
  it("handles every chunk boundary and strips only its own OSC namespace", () => {
    const source = "hello\x1b[31m" + frame() + "world\x1b]0;title\x07";
    for (let split = 0; split <= source.length; split++) {
      const received: ShellFrame[] = [];
      const parser = new ShellProtocol("secret", f => received.push(f));
      const output = parser.push(source.slice(0, split)) + parser.push(source.slice(split)) + parser.flush();
      expect(output).toBe("hello\x1b[31mworld\x1b]0;title\x07");
      expect(received).toEqual([state]);
    }
  });

  it("handles byte-sized chunks, ST terminators, Unicode, and multiple frames", () => {
    const received: ShellFrame[] = [];
    const parser = new ShellProtocol("secret", f => received.push(f));
    const second = { ...state, sequence: 2, active: false };
    let output = "";
    for (const c of frame(state, "secret", "\x1b\\") + "text" + frame(second)) output += parser.push(c);
    expect(output).toBe("text");
    expect(received).toEqual([state, second]);
  });

  it("rejects wrong authentication, replay, malformed data, invalid cursors and unbounded frames", () => {
    const received: ShellFrame[] = [];
    const parser = new ShellProtocol("secret", f => received.push(f));
    parser.push(frame(state, "wrong") + frame({ ...state, cursor: 1000 }) + frame({ ...state, active: 1 }));
    parser.push(OSC_PREFIX + "secret;not-base64\x07");
    parser.push(OSC_PREFIX + "secret;" + "a".repeat(200000));
    expect(parser.push("remaining-private-base64" + "\x1b")).toBe("");
    expect(parser.push("\\" + "visible")).toBe("visible");
    parser.push(frame());
    parser.push(frame());
    parser.push(frame({ ...state, sequence: 0 }));
    expect(received).toEqual([state]);
  });

  it("flushes incomplete unrelated escapes but never incomplete private frames", () => {
    const parser = new ShellProtocol("secret", () => {});
    expect(parser.push("foo\x1b]")).toBe("foo");
    expect(parser.flush()).toBe("\x1b]");
    parser.push(OSC_PREFIX + "secret;partial");
    expect(parser.flush()).toBe("");
  });
});
