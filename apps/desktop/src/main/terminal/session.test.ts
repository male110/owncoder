import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { ACCEPT_CHORD, createPowerShellIntegration } from "./powershell";
import { OSC_PREFIX } from "./protocol";
import { TerminalCompletionSession } from "./session";
import type { TerminalCompletionResult, TerminalShellContext } from "../../shared/terminal-completion";

const sessions: TerminalCompletionSession[] = [];
afterEach(() => { for (const session of sessions.splice(0)) session.dispose(); });
function setup(provider?: { complete(context: TerminalShellContext): Promise<TerminalCompletionResult | null> }, timeout = 100) {
  const integration = createPowerShellIntegration();
  const send = vi.fn();
  const write = vi.fn();
  const session = new TerminalCompletionSession(integration, send, write, provider, timeout);
  sessions.push(session);
  let sequence = 0;
  const publish = (line = "gi", active = true) => {
    const frame = { sequence: ++sequence, cwd: process.cwd(), line, cursor: line.length, active };
    session.protocol.push(OSC_PREFIX + integration.nonce + ";" + Buffer.from(JSON.stringify(frame)).toString("base64") + "\x07");
    return session.getContext()!;
  };
  return { session, integration, send, write, publish };
}
const accept = (revision: number, insertText = "git") => ({ id: "test", revision, from: 0, to: 2, insertText });

describe("completion session authority", () => {
  it("requires authenticated active state and matching revision", async () => {
    const { session, publish } = setup();
    expect(session.getContext()).toBeNull();
    expect(await session.complete(1)).toBeNull();
    const context = publish();
    expect(await session.complete(context.revision - 1)).toBeNull();
    expect((await session.complete(context.revision))!.items.some(i => i.label === "git")).toBe(true);
    session.invalidate();
    expect(session.getContext()?.active).toBe(false);
    expect(session.accept(accept(context.revision))).toBe(false);
    expect(await session.complete(session.getContext()!.revision)).toBeNull();
    publish("", false);
    expect(await session.complete(session.getContext()!.revision)).toBeNull();
  });

  it("accepts only issued ranges/items, writes a validated edit, and sends no text/command", async () => {
    const { session, integration, publish, write } = setup();
    const { revision } = publish();
    expect(session.accept(accept(revision))).toBe(false);
    await session.complete(revision);
    expect(session.accept({ ...accept(revision), from: 1 })).toBe(false);
    expect(session.accept(accept(revision, "git; remove-item x"))).toBe(false);
    expect(session.accept(accept(revision, "git\r"))).toBe(false);
    expect(session.accept(accept(revision))).toBe(true);
    expect(JSON.parse(readFileSync(integration.editPath, "utf8"))).toMatchObject({ nonce: integration.nonce, sequence: 1, line: "gi", cursor: 2, from: 0, to: 2, text: "git" });
    expect(write.mock.calls).toEqual([[ACCEPT_CHORD]]);
    expect(session.getContext()?.active).toBe(false);
    expect(session.accept(accept(revision))).toBe(false);
    session.invalidate();
    expect(existsSync(integration.editPath)).toBe(false);
  });

  it("rejects late provider results when context or query changes", async () => {
    let resolve!: (result: TerminalCompletionResult) => void;
    const provider = { complete: () => new Promise<TerminalCompletionResult>(r => { resolve = r; }) };
    const { session, publish } = setup(provider);
    const { revision } = publish();
    const pending = session.complete(revision);
    await Promise.resolve();
    publish("git ");
    resolve({ revision, from: 0, to: 2, items: [{ label: "git", insertText: "git", kind: "command" }] });
    expect(await pending).toBeNull();
    expect(session.accept(accept(revision))).toBe(false);
  });

  it("times out providers and handles failures without issuing edits", async () => {
    const { session, publish } = setup({ complete: () => new Promise(() => {}) }, 20);
    const { revision } = publish();
    expect(await session.complete(revision)).toBeNull();
    expect(session.accept(accept(revision))).toBe(false);
    const failed = setup({ complete: async () => { throw new Error("provider failed"); } });
    expect(await failed.session.complete(failed.publish().revision)).toBeNull();
  });

  it("forwards exact focus reports without invalidating authority or issued results", async () => {
    const { session, publish, write, send } = setup();
    const context = publish();
    await session.complete(context.revision);
    send.mockClear();
    session.writeInput("\x1b[O");
    session.writeInput("\x1b[I");
    expect(session.getContext()).toEqual(context);
    expect(send).not.toHaveBeenCalled();
    expect(write.mock.calls).toEqual([["\x1b[O"], ["\x1b[I"]]);
    expect(session.accept(accept(context.revision))).toBe(true);
  });

  it.each(["\x1b[Ia", "a\x1b[O", "\x1b[I\x1b[O", "\x1b[D", "text"])("invalidates mixed or editing input %j", data => {
    const { session, publish, write } = setup();
    const context = publish();
    session.writeInput(data);
    expect(session.getContext()?.active).toBe(false);
    expect(session.getContext()!.revision).toBeGreaterThan(context.revision);
    expect(write.mock.calls).toEqual([[data]]);
  });

  it("coalesces queries and bounds actual pending work after deadlines and disposal", async () => {
    const provider = { complete: vi.fn(() => new Promise<TerminalCompletionResult | null>(() => {})) };
    const { session, publish } = setup(provider, 15);
    const { revision } = publish();
    const pending = Array.from({ length: 30 }, () => session.complete(revision));
    expect(pending.every(promise => promise === pending[0])).toBe(true);
    await Promise.all(pending);
    for (let i = 0; i < 30; i++) {
      const context = publish(`gi${i}`);
      expect(await session.complete(context.revision)).toBeNull();
    }
    session.dispose();
    expect(provider.complete).toHaveBeenCalledTimes(1);
  });

  it("rejects unsafe typographic quotes even if a provider issued them", async () => {
    const text = "'payload’; Write-Output PWN; ‘rest'";
    const { session, publish } = setup({ complete: async context => ({ revision: context.revision, from: 0, to: 2, items: [{ label: text, insertText: text, kind: "file" }] }) });
    const { revision } = publish();
    await session.complete(revision);
    expect(session.accept(accept(revision, text))).toBe(false);
  });

  it("returns copies of authoritative contexts", () => {
    const { session, publish } = setup();
    const context = publish();
    context.active = false;
    expect(session.getContext()?.active).toBe(true);
  });
});
