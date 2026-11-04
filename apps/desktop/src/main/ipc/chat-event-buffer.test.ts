import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createChatEventBuffer, type ChatEventBufferOptions } from "./chat-event-buffer";
import type { ChatEventDto, ChatEventInputDto } from "../../preload/index";

interface Harness {
  buffer: ReturnType<typeof createChatEventBuffer>;
  /** 按发生顺序记录的发送日志。 */
  order: Array<"batch" | "single">;
  batches: Array<{ sessionId: string | null; events: ChatEventDto[] }>;
  singles: Array<{ sessionId: string | null; ev: ChatEventDto }>;
}

function makeHarness(): Harness {
  const order: Harness["order"] = [];
  const batches: Harness["batches"] = [];
  const singles: Harness["singles"] = [];
  const options: ChatEventBufferOptions = {
    charThreshold: 800,
    flushIntervalMs: 2000,
    assistantFlushIntervalMs: 500,
    thinkingFlushIntervalMs: 2000,
    sendBatch(sessionId, events) {
      batches.push({ sessionId, events: [...events] });
      order.push("batch");
    },
    sendSingle(sessionId, ev) {
      singles.push({ sessionId, ev: { ...ev } });
      order.push("single");
    },
  };
  return { buffer: createChatEventBuffer(options), order, batches, singles };
}

function assistant(text: string, sessionId = "s1"): ChatEventInputDto {
  return { type: "assistant_delta", text, sessionId };
}

function thinking(text: string, sessionId = "s1"): ChatEventInputDto {
  return { type: "thinking_delta", text, sessionId };
}

function terminal(stdout: string, sessionId = "s1"): ChatEventInputDto {
  return {
    type: "terminal",
    entry: {
      id: "t1",
      command: "ls",
      status: "running",
      at: "2026-01-01T00:00:00.000Z",
      stdout,
    },
    sessionId,
  };
}

const toolStart: ChatEventInputDto = {
  type: "tool_start",
  id: "t1",
  name: "bash",
  args: { command: "ls" },
  sessionId: "s1",
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createChatEventBuffer：delta 合并", () => {
  it("同类型连续 delta 合并为一条，只保留最新全文", () => {
    const h = makeHarness();
    h.buffer.emitChatEvent("s1", assistant("你"));
    h.buffer.emitChatEvent("s1", assistant("你好"));
    h.buffer.emitChatEvent("s1", assistant("你好，世界"));
    expect(h.order.length).toBe(0);

    vi.advanceTimersByTime(500);
    expect(h.order).toEqual(["batch"]);
    expect(h.batches[0]!.events).toEqual([
      { type: "assistant_delta", text: "你好，世界", sessionId: "s1" },
    ]);
  });

  it("thinking→assistant→thinking 不跨类型合并，且按入队顺序发出", () => {
    const h = makeHarness();
    h.buffer.emitChatEvent("s1", thinking("想"));
    h.buffer.emitChatEvent("s1", assistant("答"));
    h.buffer.emitChatEvent("s1", thinking("再想"));

    // assistant 的 500ms 计时器先到点：前缀 flush 会带上它之前的 thinking。
    vi.advanceTimersByTime(500);
    expect(h.order).toEqual(["batch"]);
    expect(h.batches[0]!.events.map((e) => e.type)).toEqual([
      "thinking_delta",
      "assistant_delta",
    ]);
    expect(h.batches[0]!.events[1]).toMatchObject({ text: "答" });

    // 剩下的 thinking 在自己的 2000ms 计时器到点后发出（先到的 thinking 旧计时器已失效）。
    vi.advanceTimersByTime(1500);
    expect(h.order).toEqual(["batch", "batch"]);
    expect(h.batches[1]!.events).toEqual([
      { type: "thinking_delta", text: "再想", sessionId: "s1" },
    ]);
  });

  it("同类型被其它类型隔开后形成独立槽位，分批但按序发出", () => {
    const h = makeHarness();
    h.buffer.emitChatEvent("s1", assistant("第一段"));
    h.buffer.emitChatEvent("s1", thinking("想一想"));
    h.buffer.emitChatEvent("s1", assistant("第二段"));
    vi.advanceTimersByTime(500);

    // 两个 assistant 槽位各有自己的 500ms 计时器，依次前缀 flush。
    expect(h.order).toEqual(["batch", "batch"]);
    expect(h.batches[0]!.events).toEqual([
      { type: "assistant_delta", text: "第一段", sessionId: "s1" },
    ]);
    expect(h.batches[1]!.events).toEqual([
      { type: "thinking_delta", text: "想一想", sessionId: "s1" },
      { type: "assistant_delta", text: "第二段", sessionId: "s1" },
    ]);
  });
});

describe("createChatEventBuffer：字符阈值只计增量", () => {
  it("累计全文重复增长时，阈值按新增字符累计", () => {
    const h = makeHarness();
    // delta 携带累计全文：600 → 700 → 800，每步只新增 100。
    h.buffer.emitChatEvent("s1", assistant("a".repeat(600)));
    expect(h.order.length).toBe(0);
    h.buffer.emitChatEvent("s1", assistant("a".repeat(700)));
    // 旧实现按全文累计（600+700=1300）会在这里提前 flush。
    expect(h.order.length).toBe(0);

    h.buffer.emitChatEvent("s1", assistant("a".repeat(800)));
    expect(h.order.length).toBe(1);
    expect(h.batches[0]!.events[0]).toMatchObject({ text: "a".repeat(800) });
  });

  it("单条新增超过阈值时立即 flush（流式很快时不必等计时器）", () => {
    const h = makeHarness();
    h.buffer.emitChatEvent("s1", assistant("b".repeat(1000)));
    expect(h.order).toEqual(["batch"]);
    expect(h.batches[0]!.events[0]).toMatchObject({ text: "b".repeat(1000) });
  });

  it("替换为更短的文本（如 finalReport 整体替换）不重复计数", () => {
    const h = makeHarness();
    h.buffer.emitChatEvent("s1", assistant("x".repeat(100)));
    h.buffer.emitChatEvent("s1", assistant("done"));
    expect(h.order.length).toBe(0);
    vi.advanceTimersByTime(500);
    expect(h.order).toEqual(["batch"]);
    expect(h.batches[0]!.events[0]).toMatchObject({ text: "done" });
  });
});

describe("createChatEventBuffer：刷新间隔", () => {
  it("assistant 500ms、thinking 2000ms 各自独立计时", () => {
    const h = makeHarness();
    h.buffer.emitChatEvent("s1", assistant("hello"));
    vi.advanceTimersByTime(499);
    expect(h.order.length).toBe(0);
    vi.advanceTimersByTime(1);
    expect(h.order).toEqual(["batch"]);

    h.buffer.emitChatEvent("s1", thinking("hmm"));
    vi.advanceTimersByTime(1999);
    expect(h.order.length).toBe(1);
    vi.advanceTimersByTime(1);
    expect(h.order).toEqual(["batch", "batch"]);
  });

  it("terminal 等其它缓冲事件在通用间隔内合并为一批", () => {
    const h = makeHarness();
    h.buffer.emitChatEvent("s1", terminal("line1\n"));
    h.buffer.emitChatEvent("s1", terminal("line2\n"));
    vi.advanceTimersByTime(1999);
    expect(h.order.length).toBe(0);
    vi.advanceTimersByTime(1);
    expect(h.order).toEqual(["batch"]);
    expect(h.batches[0]!.events.map((e) => e.type)).toEqual(["terminal", "terminal"]);
  });

  it("terminal 与 delta 混合时按入队顺序同批发出", () => {
    const h = makeHarness();
    h.buffer.emitChatEvent("s1", terminal("line1\n"));
    h.buffer.emitChatEvent("s1", assistant("正文"));
    vi.advanceTimersByTime(500);
    expect(h.order).toEqual(["batch"]);
    expect(h.batches[0]!.events.map((e) => e.type)).toEqual(["terminal", "assistant_delta"]);
  });

  it("未指定分类型间隔时，delta 沿用通用 flushIntervalMs", () => {
    const batches: ChatEventDto[][] = [];
    const buffer = createChatEventBuffer({
      charThreshold: 1000,
      flushIntervalMs: 100,
      sendBatch(_sid, events) {
        batches.push([...events]);
      },
      sendSingle() {},
    });
    buffer.emitChatEvent("s1", thinking("short"));
    vi.advanceTimersByTime(99);
    expect(batches.length).toBe(0);
    vi.advanceTimersByTime(1);
    expect(batches.length).toBe(1);
    expect(batches[0]).toEqual([{ type: "thinking_delta", text: "short", sessionId: "s1" }]);
  });
});

describe("createChatEventBuffer：保序与生命周期", () => {
  it("非缓冲事件先冲空队列再发送，顺序为 batch → single", () => {
    const h = makeHarness();
    h.buffer.emitChatEvent("s1", assistant("正文"));
    h.buffer.emitChatEvent("s1", toolStart);
    expect(h.order).toEqual(["batch", "single"]);
    expect(h.batches[0]!.events[0]).toMatchObject({ type: "assistant_delta", text: "正文" });
    expect(h.singles[0]!.ev).toMatchObject({ type: "tool_start", id: "t1" });
  });

  it("turn_complete 同样先冲队列再发送", () => {
    const h = makeHarness();
    h.buffer.emitChatEvent("s1", assistant("done"));
    h.buffer.emitChatEvent("s1", {
      type: "turn_complete",
      parts: [],
      metadata: {},
      sessionId: "s1",
    });
    expect(h.order).toEqual(["batch", "single"]);
    expect(h.singles[0]!.ev.type).toBe("turn_complete");
  });

  it("多会话缓冲互相隔离", () => {
    const h = makeHarness();
    h.buffer.emitChatEvent("s1", assistant("s1 正文", "s1"));
    h.buffer.emitChatEvent("s2", assistant("s2 正文", "s2"));
    vi.advanceTimersByTime(500);
    expect(h.order).toEqual(["batch", "batch"]);
    expect(h.batches[0]!.events[0]).toMatchObject({ text: "s1 正文", sessionId: "s1" });
    expect(h.batches[1]!.events[0]).toMatchObject({ text: "s2 正文", sessionId: "s2" });
  });

  it("flushAll 冲掉所有会话的待发内容", () => {
    const h = makeHarness();
    h.buffer.emitChatEvent("s1", assistant("s1", "s1"));
    h.buffer.emitChatEvent("s2", thinking("s2", "s2"));
    h.buffer.flushAll();
    expect(h.order).toEqual(["batch", "batch"]);
    expect(h.batches[0]!.sessionId).toBe("s1");
    expect(h.batches[1]!.sessionId).toBe("s2");
  });

  it("removeSession 清理计时器并不再发送", () => {
    const h = makeHarness();
    h.buffer.emitChatEvent("s1", assistant("残留"));
    h.buffer.emitChatEvent("s1", terminal("残留输出"));
    h.buffer.removeSession("s1");
    vi.advanceTimersByTime(10_000);
    expect(h.order.length).toBe(0);
  });

  it("flushSession 只影响目标会话", () => {
    const h = makeHarness();
    h.buffer.emitChatEvent("s1", assistant("s1", "s1"));
    h.buffer.emitChatEvent("s2", assistant("s2", "s2"));
    h.buffer.flushSession("s1");
    expect(h.order).toEqual(["batch"]);
    expect(h.batches[0]!.events[0]).toMatchObject({ text: "s1", sessionId: "s1" });
    vi.advanceTimersByTime(500);
    expect(h.order).toEqual(["batch", "batch"]);
    expect(h.batches[1]!.events[0]).toMatchObject({ text: "s2", sessionId: "s2" });
  });
});
