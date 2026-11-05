import { beforeEach, describe, expect, it, vi } from "vitest";
import { chatCompletionStream, type ChatMessage } from "@owncoder/llm";
import { doPlainCompletion } from "./index.ts";
import type { SchedulerContext } from "./types.ts";

vi.mock("@owncoder/llm", async (importOriginal) => ({
  ...await importOriginal<typeof import("@owncoder/llm")>(),
  assertLlmAuth: vi.fn(),
  chatCompletionStream: vi.fn(),
}));

function makeCtx(extra: Record<string, unknown> = {}): SchedulerContext {
  const messages: ChatMessage[] = [
    { role: "system", content: "system" },
    { role: "user", content: "hello" },
  ];
  return {
    opts: {
      mode: "agent",
      sessionId: "plain-test",
      signal: undefined,
      llmApiKey: "key",
      workflow: { thinking: {} },
      onEvent: vi.fn(),
    },
    model: { model: "test-model" },
    messages,
    history: [],
    tracer: { startSpan: vi.fn(() => "s1"), endSpan: vi.fn(), recordTokenUsage: vi.fn() },
    state: {},
    ...extra,
  } as unknown as SchedulerContext;
}

function mockResponse(content: string) {
  vi.mocked(chatCompletionStream).mockResolvedValueOnce({
    choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  } as Awaited<ReturnType<typeof chatCompletionStream>>);
}

describe("doPlainCompletion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("调用附带 Markdown 输出契约，Markdown 回答写入历史并返回", async () => {
    const answer = "## 标题\n- 要点一\n- 要点二";
    mockResponse(answer);
    const ctx = makeCtx();
    const out = await doPlainCompletion(ctx);
    expect(out).toBe(answer);
    expect(ctx.history).toEqual([{ role: "assistant", content: answer }]);
    const sent = vi.mocked(chatCompletionStream).mock.calls[0]![1] as ChatMessage[];
    expect(sent).toHaveLength(3);
    expect(sent.at(-1)?.content).toMatch(/Markdown/);
    // 持久消息数组不被污染
    expect(ctx.messages).toHaveLength(2);
  });

  it("空回答不写入历史并返回空字符串", async () => {
    mockResponse("   ");
    const ctx = makeCtx();
    const out = await doPlainCompletion(ctx);
    expect(out).toBe("   ");
    expect(ctx.history).toHaveLength(0);
  });

  it("非中止异常时返回空字符串并发 error 事件，不抛出", async () => {
    vi.mocked(chatCompletionStream).mockRejectedValueOnce(new Error("api down"));
    const ctx = makeCtx();
    const out = await doPlainCompletion(ctx);
    expect(out).toBe("");
    expect(ctx.opts.onEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "error" }));
  });

  it("中止时保留已累积文本并写入历史", async () => {
    const aborted = new AbortController();
    aborted.abort();
    vi.mocked(chatCompletionStream).mockRejectedValueOnce(Object.assign(new Error("aborted"), { name: "AbortError" }));
    const ctx = makeCtx({
      opts: {
        mode: "agent", sessionId: "x", signal: aborted.signal, llmApiKey: "k",
        workflow: { thinking: {} }, onEvent: vi.fn(),
      },
    });
    const out = await doPlainCompletion(ctx);
    expect(ctx.state.aborted).toBe(true);
    expect(out).toBe("");
  });
});
