import { describe, expect, it, vi } from "vitest";
import { SessionRunCoordinator } from "./session-coordinator";

describe("SessionRunCoordinator lifecycle", () => {
  it("cleans up an active entry after its fiber settles", async () => {
    let release!: () => void;
    const handler = vi.fn(() => new Promise<string>((resolve) => { release = () => resolve("done"); }));
    const coordinator = new SessionRunCoordinator(handler, async () => false);

    const result = coordinator.admit("s1", "hello");
    await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce());
    const cleanup = coordinator.cleanup("s1");
    expect(coordinator.getStats().totalSessions).toBe(1);
    release();
    await cleanup;
    await expect(result).resolves.toBe("done");
    expect(coordinator.getStats().totalSessions).toBe(0);
  });

  it("continues draining queued inputs after a completed turn", async () => {
    const handled: string[] = [];
    const coordinator = new SessionRunCoordinator(
      async (_sessionId, input) => {
        handled.push(input.text);
        return input.text;
      },
      async () => false,
    );

    const first = coordinator.admit("s1", "first");
    await vi.waitFor(() => expect(handled).toEqual(["first"]));
    const second = coordinator.admit("s1", "second");

    await expect(first).resolves.toBe("first");
    await expect(second).resolves.toBe("second");
    expect(handled).toEqual(["first", "second"]);
  });

  it("continues draining when the continuation check fails", async () => {
    const handled: string[] = [];
    const coordinator = new SessionRunCoordinator(
      async (_sessionId, input) => {
        handled.push(input.text);
        return input.text;
      },
      async () => { throw new Error("check failed"); },
    );

    const first = coordinator.admit("s1", "first");
    await vi.waitFor(() => expect(handled).toEqual(["first"]));
    const second = coordinator.admit("s1", "second");

    await expect(first).resolves.toBe("first");
    await expect(second).resolves.toBe("second");
    expect(handled).toEqual(["first", "second"]);
  });

  it("rejects input beyond the pending queue limit", async () => {
    let stop!: () => void;
    const coordinator = new SessionRunCoordinator(
      async () => new Promise<void>((resolve) => { stop = resolve; }),
      async () => false,
      { maxPendingInputs: 1 },
    );
    const first = coordinator.admit("s1", "first");
    await vi.waitFor(() => expect(coordinator.isActive("s1")).toBe(true));
    const queued = coordinator.admit("s1", "queued");
    const rejected = coordinator.admit("s1", "second");
    await expect(rejected).rejects.toThrow("input queue is full");
    stop();
    await coordinator.interrupt("s1");
    await expect(first).resolves.toBeUndefined();
    await expect(queued).rejects.toThrow("interrupted");
  });
});
