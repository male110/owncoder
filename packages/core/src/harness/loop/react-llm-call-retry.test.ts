import { afterEach, describe, expect, it, vi } from "vitest";
import { chatCompletionStream } from "@owncoder/llm";
import { callModelForIteration } from "./react-llm-call.ts";
import type { ReActLoopContext } from "./react-loop-context.ts";

vi.mock("@owncoder/llm", async (importOriginal) => ({
  ...await importOriginal<typeof import("@owncoder/llm")>(),
  chatCompletionStream: vi.fn(),
}));
vi.mock("./react-finalize.ts", () => ({
  applyRunEvent: vi.fn(),
  finalizeTerminal: vi.fn(),
}));

function makeCtx(onEvent: ReturnType<typeof vi.fn>, llmMaxRetries = 1): ReActLoopContext {
  return {
    model: { model: "test-model" },
    stageId: "react",
    llmMaxRetries,
    messages: [{ role: "user", content: "用户请求" }],
    currentTask: null,
    opts: { sessionId: "retry-test", onEvent },
    tracer: { startSpan: vi.fn(() => "span-1"), endSpan: vi.fn(), recordTokenUsage: vi.fn(), addEvent: vi.fn(), recordError: vi.fn() },
    history: [],
    lastAssistant: "",
  } as unknown as ReActLoopContext;
}

const okResponse = {
  choices: [{ message: { role: "assistant", content: "完成" }, finish_reason: "stop" }],
} as unknown as Awaited<ReturnType<typeof chatCompletionStream>>;

function retryEvents(onEvent: ReturnType<typeof vi.fn>) {
  return onEvent.mock.calls.map(([ev]) => ev).filter((ev) => ev.type === "llm_retry");
}

describe("callModelForIteration 的 llm_retry 透传", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.mocked(chatCompletionStream).mockReset();
  });

  it("LLM 层内部重试（超时/网络/HTTP）原样透传倒计时字段", async () => {
    const onEvent = vi.fn();
    const ctx = makeCtx(onEvent, 0);
    vi.mocked(chatCompletionStream).mockImplementation(async (_model, _messages, options) => {
      options?.onRetry?.({ attempt: 1, maxRetries: 3, delayMs: 3000, reason: "timeout" });
      return okResponse;
    });

    expect((await callModelForIteration(ctx, 0)).kind).toBe("ok");
    expect(retryEvents(onEvent)).toEqual([
      { type: "llm_retry", attempt: 1, maxRetries: 3, delayMs: 3000, reason: "timeout" },
    ]);
  });

  it("空响应兜底重试也上报，界面因此不会一直显示「思考中…」", async () => {
    vi.useFakeTimers();
    const onEvent = vi.fn();
    const ctx = makeCtx(onEvent, 1);
    let calls = 0;
    vi.mocked(chatCompletionStream).mockImplementation(async () => {
      calls++;
      // 第一次返回既无文本也无工具调用的空响应，触发 harness 层重试
      if (calls === 1) {
        return { choices: [{ message: { role: "assistant", content: "" }, finish_reason: "stop" }] } as unknown as typeof okResponse;
      }
      return okResponse;
    });

    const promise = callModelForIteration(ctx, 0);
    await vi.advanceTimersByTimeAsync(0);
    expect(retryEvents(onEvent)).toEqual([
      {
        type: "llm_retry",
        attempt: 1,
        maxRetries: 1,
        delayMs: 2000,
        reason: "LLM 返回空响应（无文本内容且无工具调用）",
      },
    ]);
    await vi.advanceTimersByTimeAsync(2000);

    expect((await promise).kind).toBe("ok");
    expect(ctx.tracer.addEvent).toHaveBeenCalledWith(
      expect.anything(),
      "retry",
      expect.objectContaining({ attempt: 1, delayMs: 2000 }),
    );
  });

  it("用户取消不上报重试，直接以 interrupted 终态退出", async () => {
    const onEvent = vi.fn();
    const ac = new AbortController();
    const ctx = makeCtx(onEvent, 1);
    (ctx.opts as { signal?: AbortSignal }).signal = ac.signal;
    ac.abort(new Error("user cancelled"));
    vi.mocked(chatCompletionStream).mockRejectedValue(Object.assign(new Error("user cancelled"), { name: "AbortError" }));

    const out = await callModelForIteration(ctx, 0);
    expect(out.kind).toBe("exit");
    expect(retryEvents(onEvent)).toEqual([]);
  });
});
