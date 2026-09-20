import { describe, expect, it, vi } from "vitest";
import { createChatEventBuffer } from "../../../main/ipc/chat-event-buffer";

function createFixture(options?: { charThreshold?: number }) {
  const sendBatch = vi.fn();
  const sendSingle = vi.fn();
  const buffer = createChatEventBuffer({ ...options, sendBatch, sendSingle });
  return { buffer, sendBatch, sendSingle };
}

describe("chat-event-buffer", () => {
  it("flushes a single buffered event as one message", () => {
    const { buffer, sendBatch, sendSingle } = createFixture();

    buffer.emitChatEvent("s1", { type: "thinking_delta", text: "hello" });
    buffer.flushSession("s1");

    expect(sendBatch).toHaveBeenCalledTimes(1);
    expect(sendBatch.mock.calls[0]?.[0]).toBe("s1");
    expect(sendBatch.mock.calls[0]?.[1]).toEqual([{ type: "thinking_delta", text: "hello", sessionId: "s1" }]);
    expect(sendSingle).not.toHaveBeenCalled();
  });

  it("flushes multiple buffered events as a batch", () => {
    const { buffer, sendBatch } = createFixture();

    buffer.emitChatEvent("s1", { type: "thinking_delta", text: "a" });
    buffer.emitChatEvent("s1", { type: "assistant_delta", text: "b" });
    buffer.emitChatEvent("s1", { type: "terminal", entry: { id: "t1" } });
    buffer.flushSession("s1");

    expect(sendBatch).toHaveBeenCalledTimes(1);
    expect(sendBatch.mock.calls[0]?.[0]).toBe("s1");
    expect(sendBatch.mock.calls[0]?.[1]).toEqual([
      { type: "thinking_delta", text: "a", sessionId: "s1" },
      { type: "assistant_delta", text: "b", sessionId: "s1" },
      { type: "terminal", entry: { id: "t1" }, sessionId: "s1" },
    ]);
  });

  it("sends critical events immediately and flushes pending first", () => {
    const { buffer, sendBatch, sendSingle } = createFixture();

    buffer.emitChatEvent("s1", { type: "thinking_delta", text: "pending" });
    buffer.emitChatEvent("s1", { type: "turn_complete", parts: [], metadata: {} });

    expect(sendBatch).toHaveBeenCalledTimes(1);
    expect(sendBatch.mock.calls[0]?.[1]).toHaveLength(1);
    expect(sendSingle).toHaveBeenCalledWith("s1", { type: "turn_complete", parts: [], metadata: {}, sessionId: "s1" });
  });

  it("keeps per-session buffers independent", () => {
    const { buffer, sendBatch } = createFixture();

    buffer.emitChatEvent("a", { type: "thinking_delta", text: "a1" });
    buffer.emitChatEvent("b", { type: "assistant_delta", text: "b1" });
    buffer.flushSession("a");
    buffer.flushSession("b");

    expect(sendBatch).toHaveBeenCalledTimes(2);
    expect(sendBatch.mock.calls[0]?.[0]).toBe("a");
    expect(sendBatch.mock.calls[1]?.[0]).toBe("b");
    expect(sendBatch.mock.calls[0]?.[1]).toEqual([{ type: "thinking_delta", text: "a1", sessionId: "a" }]);
    expect(sendBatch.mock.calls[1]?.[1]).toEqual([{ type: "assistant_delta", text: "b1", sessionId: "b" }]);
  });

  it("flushes when char threshold is exceeded", () => {
    const { buffer, sendBatch, sendSingle } = createFixture({ charThreshold: 4 });

    buffer.emitChatEvent("s1", { type: "thinking_delta", text: "123" });
    expect(sendBatch).not.toHaveBeenCalled();

    buffer.emitChatEvent("s1", { type: "assistant_delta", text: "56" });
    expect(sendBatch).toHaveBeenCalledTimes(1);
    expect(sendBatch.mock.calls[0]?.[1]).toHaveLength(2);
    expect(sendSingle).not.toHaveBeenCalled();
  });

  it("flushes on time threshold when char threshold not reached", async () => {
    vi.useFakeTimers();
    try {
      const { buffer, sendBatch } = createFixture({ charThreshold: 1000, flushIntervalMs: 100 });

      buffer.emitChatEvent("s1", { type: "thinking_delta", text: "short" });
      expect(sendBatch).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(100);
      expect(sendBatch).toHaveBeenCalledTimes(1);
      expect(sendBatch.mock.calls[0]?.[1]).toEqual([{ type: "thinking_delta", text: "short", sessionId: "s1" }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stamps a real sessionId onto task_update and rejects missing ids", () => {
    const { buffer, sendSingle } = createFixture();

    buffer.emitChatEvent("s1", { type: "task_update", tasks: [], currentTaskId: null });
    expect(sendSingle).toHaveBeenCalledWith("s1", {
      type: "task_update",
      tasks: [],
      currentTaskId: null,
      sessionId: "s1",
    });

    expect(() => buffer.emitChatEvent(null, { type: "thinking_delta", text: "x" })).toThrow(
      /sessionId/,
    );
    expect(() => buffer.emitChatEvent("", { type: "task_update", tasks: [], currentTaskId: null })).toThrow(
      /sessionId/,
    );
  });

  it("flushes pending then sends task_run_state immediately", () => {
    const { buffer, sendBatch, sendSingle } = createFixture();

    buffer.emitChatEvent("s1", { type: "thinking_delta", text: "pending" });
    buffer.emitChatEvent("s1", {
      type: "task_run_state",
      phase: "verifying",
      taskId: "s1",
      verificationStatus: "not_run",
      verificationPassed: false,
      verificationSummary: "尚未验证",
      repairAttempts: 0,
      maxRepairAttempts: 3,
      label: "验证中…",
    });

    expect(sendBatch).toHaveBeenCalledTimes(1);
    expect(sendBatch.mock.calls[0]?.[1]).toEqual([
      { type: "thinking_delta", text: "pending", sessionId: "s1" },
    ]);
    expect(sendSingle).toHaveBeenCalledWith("s1", {
      type: "task_run_state",
      phase: "verifying",
      taskId: "s1",
      verificationStatus: "not_run",
      verificationPassed: false,
      verificationSummary: "尚未验证",
      repairAttempts: 0,
      maxRepairAttempts: 3,
      label: "验证中…",
      sessionId: "s1",
    });
  });
});
