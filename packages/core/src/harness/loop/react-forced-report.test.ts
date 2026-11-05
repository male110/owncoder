import { beforeEach, describe, expect, it, vi } from "vitest";
import { chatCompletionStream } from "@owncoder/llm";
import { forcedFinalReport } from "./react-forced-report.ts";
import type { ReActLoopContext } from "./react-loop-context.ts";

vi.mock("@owncoder/llm", async (importOriginal) => ({
  ...await importOriginal<typeof import("@owncoder/llm")>(),
  chatCompletionStream: vi.fn(),
}));

function makeCtx(extra: Record<string, unknown> = {}): ReActLoopContext {
  return {
    model: { model: "test-model" },
    stageId: "react",
    messages: [{ role: "system", content: "system" }, { role: "user", content: "q" }],
    history: [],
    lastAssistant: "",
    opts: {
      sessionId: "forced-test",
      signal: undefined,
      llmApiKey: "key",
      onEvent: vi.fn(),
    },
    ...extra,
  } as unknown as ReActLoopContext;
}

function mockResponse(content: string) {
  vi.mocked(chatCompletionStream).mockResolvedValueOnce({
    choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
  } as Awaited<ReturnType<typeof chatCompletionStream>>);
}

describe("forcedFinalReport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("提示词要求 Markdown 报告，Markdown 回答原样返回", async () => {
    const report = [
      "## Searched",
      "- `src/` glob",
      "## Findings",
      "- `src/a.ts:12` 找到入口",
      "## Gaps",
      "- 下游调用未确认",
    ].join("\n");
    mockResponse(report);
    const out = await forcedFinalReport(makeCtx(), "iteration cap");
    expect(out).toBe(report);
    const instruction = (vi.mocked(chatCompletionStream).mock.calls[0]![1] as { content: string }[]).at(-1)!;
    expect(instruction.content).toMatch(/Markdown/);
    expect(instruction.content).toContain("## Searched");
  });

  it("空回答时回退到历史中已有的 assistant 文本", async () => {
    mockResponse("   ");
    const ctx = makeCtx({
      lastAssistant: "",
      history: [
        { role: "user", content: "q" },
        { role: "assistant", content: "之前的发现：src/a.ts" },
      ],
    });
    const out = await forcedFinalReport(ctx, "iteration cap");
    expect(out).toBe("之前的发现：src/a.ts");
  });

  it("调用异常时回退到已有文本并发出 warning，不抛错", async () => {
    vi.mocked(chatCompletionStream).mockRejectedValueOnce(new Error("network down"));
    const ctx = makeCtx({ lastAssistant: "已有结论" });
    const out = await forcedFinalReport(ctx, "iteration cap");
    expect(out).toBe("已有结论");
    expect(ctx.opts.onEvent).toHaveBeenCalled();
  });

  it("无任何已有文本且调用失败时返回占位说明", async () => {
    vi.mocked(chatCompletionStream).mockRejectedValueOnce(new Error("boom"));
    const out = await forcedFinalReport(makeCtx(), "iteration cap");
    expect(out).toContain("no report text was produced");
  });

  it("中止时保留已收集文本，不强行总结", async () => {
    const aborted = new AbortController();
    aborted.abort();
    vi.mocked(chatCompletionStream).mockRejectedValueOnce(Object.assign(new Error("aborted"), { name: "AbortError" }));
    const ctx = makeCtx({
      lastAssistant: "中断前文本",
      opts: { sessionId: "x", signal: aborted.signal, llmApiKey: "k", onEvent: vi.fn() },
    });
    const out = await forcedFinalReport(ctx, "cap");
    expect(out).toBe("中断前文本");
  });
});
