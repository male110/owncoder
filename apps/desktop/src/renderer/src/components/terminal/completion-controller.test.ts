import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { completionKeyAction, TerminalCompletionController, type CompletionMenuState } from "./completion-controller";
import type { TerminalCompletionResult, TerminalShellContext } from "../../../../shared/terminal-completion";

const context = (revision = 1, line = "git checkout ex"): TerminalShellContext => ({
  revision, line, cwd: "E:/repo", cursor: line.length, active: true,
});
const result = (revision = 1): TerminalCompletionResult => ({
  revision, from: 13, to: 15,
  items: [
    { label: "example", insertText: "example", kind: "branch" },
    { label: "experiment", insertText: "experiment", kind: "branch" },
  ],
});
const key = (name: string, extra = {}) => ({
  key: name, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, isComposing: false, ...extra,
});

function setup() {
  const complete = vi.fn().mockResolvedValue(result());
  const accept = vi.fn().mockResolvedValue(true);
  let menu: CompletionMenuState | null = null;
  const change = vi.fn((value: CompletionMenuState | null) => { menu = value; });
  const controller = new TerminalCompletionController("pty-1", { complete, accept }, change);
  return { controller, complete, accept, change, menu: () => menu };
}

describe("TerminalCompletionController", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("debounces authoritative shell updates and queries only the newest revision", async () => {
    const h = setup();
    h.controller.update(context(1));
    h.controller.update(context(2));
    h.complete.mockResolvedValue(result(2));
    await vi.advanceTimersByTimeAsync(90);
    expect(h.complete).toHaveBeenCalledExactlyOnceWith({ id: "pty-1", revision: 2 });
    expect(h.menu()?.result.revision).toBe(2);
    h.controller.dispose();
  });

  it("does not query inactive, empty or multiline shell input", async () => {
    const h = setup();
    h.controller.update({ ...context(), active: false });
    await vi.runAllTimersAsync();
    h.controller.update(context(2, " "));
    await vi.runAllTimersAsync();
    h.controller.update(context(3, "git checkout\nex"));
    await vi.runAllTimersAsync();
    expect(h.complete).not.toHaveBeenCalled();
  });

  it("ignores stale initial snapshots and results", async () => {
    const h = setup();
    h.controller.update(context(2));
    h.controller.update(context(1));
    await vi.runAllTimersAsync();
    expect(h.complete).toHaveBeenCalledExactlyOnceWith({ id: "pty-1", revision: 2 });
    expect(h.menu()).toBeNull();
  });

  it("discards an in-flight response as soon as raw input invalidates it", async () => {
    const h = setup();
    let resolve!: (value: TerminalCompletionResult) => void;
    h.complete.mockReturnValue(new Promise<TerminalCompletionResult>((done) => { resolve = done; }));
    h.controller.update(context());
    await vi.advanceTimersByTimeAsync(90);
    h.controller.invalidate();
    resolve(result());
    await Promise.resolve();
    expect(h.menu()).toBeNull();
    expect(h.controller.handleKey(key("Tab"))).toBe(false);
  });

  it("only accepts a selected issued item and never forwards Enter as command execution", async () => {
    const h = setup();
    h.controller.update(context());
    await vi.runAllTimersAsync();
    expect(h.controller.handleKey(key("ArrowUp"))).toBe(true);
    expect(h.menu()?.selected).toBe(1);
    expect(h.controller.handleKey(key("Enter"))).toBe(true);
    expect(h.accept).toHaveBeenCalledExactlyOnceWith({
      id: "pty-1", revision: 1, from: 13, to: 15, insertText: "experiment",
    });
    expect(h.menu()).toBeNull();
    expect(h.controller.handleKey(key("Enter"))).toBe(false);
  });

  it("cycles selection, supports Shift+Tab, and Escape dismisses until another update", async () => {
    const h = setup();
    h.controller.update(context());
    await vi.runAllTimersAsync();
    h.controller.handleKey(key("ArrowDown"));
    h.controller.handleKey(key("ArrowDown"));
    expect(h.menu()?.selected).toBe(0);
    h.controller.handleKey(key("Tab", { shiftKey: true }));
    expect(h.menu()?.selected).toBe(1);
    expect(h.controller.handleKey(key("Escape"))).toBe(true);
    h.controller.update(context());
    await vi.runAllTimersAsync();
    expect(h.menu()).toBeNull();
    expect(h.accept).not.toHaveBeenCalled();
  });

  it("does not intercept shell shortcuts or composition and does not accept arbitrary indices", async () => {
    const h = setup();
    h.controller.update(context());
    await vi.runAllTimersAsync();
    expect(h.controller.handleKey(key("Tab", { ctrlKey: true }))).toBe(false);
    expect(h.controller.handleKey(key("Enter", { isComposing: true }))).toBe(false);
    expect(h.controller.handleKey(key("ArrowRight"))).toBe(false);
    expect(h.controller.accept(100)).toBe(false);
    expect(h.accept).not.toHaveBeenCalled();
  });

  it("silently falls back to shell behavior on failed or empty queries", async () => {
    const h = setup();
    h.complete.mockRejectedValueOnce(new Error("closed"));
    h.controller.update(context());
    await vi.runAllTimersAsync();
    expect(h.menu()).toBeNull();
    h.complete.mockResolvedValueOnce({ ...result(2), items: [] });
    h.controller.update(context(2));
    await vi.runAllTimersAsync();
    expect(h.menu()).toBeNull();
  });

  it("does not reopen after blur and resumes the latest context on focus", async () => {
    const h = setup();
    h.controller.update(context());
    h.controller.setEnabled(false);
    h.controller.update(context(2));
    await vi.runAllTimersAsync();
    expect(h.complete).not.toHaveBeenCalled();
    h.complete.mockResolvedValue(result(2));
    h.controller.setEnabled(true);
    await vi.runAllTimersAsync();
    expect(h.complete).toHaveBeenCalledExactlyOnceWith({ id: "pty-1", revision: 2 });
    expect(h.menu()?.result.revision).toBe(2);
  });

  it("cancels queries and ignores updates after disposal", async () => {
    const h = setup();
    h.controller.update(context());
    h.controller.dispose();
    h.controller.update(context(2));
    await vi.runAllTimersAsync();
    expect(h.complete).not.toHaveBeenCalled();
    expect(h.menu()).toBeNull();
  });
});

describe("completionKeyAction", () => {
  it("preserves modified Enter and native right-arrow behavior", () => {
    expect(completionKeyAction(key("Enter", { shiftKey: true }))).toBeNull();
    expect(completionKeyAction(key("Enter", { altKey: true }))).toBeNull();
    expect(completionKeyAction(key("ArrowRight"))).toBeNull();
    expect(completionKeyAction(key("ArrowUp", { shiftKey: true }))).toBeNull();
    expect(completionKeyAction(key("ArrowDown", { shiftKey: true }))).toBeNull();
    expect(completionKeyAction(key("Escape", { shiftKey: true }))).toBeNull();
    expect(completionKeyAction(key("Tab"))).toBe("accept");
  });
});
