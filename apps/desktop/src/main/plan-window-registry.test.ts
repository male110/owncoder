import { describe, expect, it, vi } from "vitest";
import type { BrowserWindow } from "electron";
import { focusExistingPlanWindow } from "./plan-window-registry";

describe("focusExistingPlanWindow", () => {
  it("focuses an existing plan window rather than creating another one", () => {
    const window = { isDestroyed: vi.fn(() => false), isMinimized: vi.fn(() => true), restore: vi.fn(), show: vi.fn(), focus: vi.fn() };
    const windows = new Map([["session/plan", window as unknown as BrowserWindow]]);
    expect(focusExistingPlanWindow(windows, "session/plan")).toBe(true);
    expect(windows.size).toBe(1);
    expect(window.restore).toHaveBeenCalledOnce();
    expect(window.show).toHaveBeenCalledOnce();
    expect(window.focus).toHaveBeenCalledOnce();
  });

  it("does not reuse missing or destroyed plan windows", () => {
    const window = { isDestroyed: () => true };
    const windows = new Map([["session/plan", window as BrowserWindow]]);
    expect(focusExistingPlanWindow(windows, "session/plan")).toBe(false);
    expect(focusExistingPlanWindow(windows, "another/plan")).toBe(false);
  });
});
