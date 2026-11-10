import { describe, expect, it, vi } from "vitest";
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

describe("分析报告的请求与响应格式链路", () => {
  it("每轮注入结构化要求，流式与最终正文逐字保留 Markdown 和业务结论", async () => {
    const report = [
      "## 结论", "", "项目规范以 `@EnumValue` 为主。", "",
      "## 证据", "", "- `WrongSelectModeEnum.java:4-38` 的 value 字段同时使用 `@EnumValue`、`@JsonValue`。", "",
      "## 注解示例", "", "```java", "@EnumValue", "@JsonValue", "private final Integer value;", "```",
    ].join("\n");
    const onEvent = vi.fn();
    vi.mocked(chatCompletionStream).mockImplementation(async (_model, messages, options) => {
      const systemText = messages.filter((message) => message.role === "system").map((message) => message.content).join("\n");
      expect(systemText).not.toMatch(/report the result in one sentence/i);
      expect(systemText).toContain("Markdown headings (## / ###)");
      expect(systemText).toContain("bullet or numbered lists");
      expect(systemText).toContain("fenced code blocks");
      for (let end = 1; end <= report.length; end++) options?.onDelta?.(report.slice(0, end));
      return {
        choices: [{ message: { role: "assistant", content: report }, finish_reason: "stop" }],
      } as Awaited<ReturnType<typeof chatCompletionStream>>;
    });
    const ctx = {
      model: { model: "test-model" }, stageId: "react", llmMaxRetries: 0,
      messages: [{ role: "system", content: "使用 Markdown 回答" }, { role: "user", content: "分析枚举注解规范并提供证据与示例" }],
      currentTask: { id: "format", description: "分析 @EnumValue 与 @JsonValue 的项目使用规范", status: "in_progress", dependsOn: [], retryCount: 0, maxRetries: 2 },
      opts: { sessionId: "format-test", onEvent },
      tracer: { startSpan: vi.fn(), endSpan: vi.fn(), recordTokenUsage: vi.fn() },
      history: [], lastAssistant: "",
    } as unknown as ReActLoopContext;

    for (const iteration of [0, 1]) {
      const out = await callModelForIteration(ctx, iteration);
      expect(out.kind).toBe("ok");
      if (out.kind === "ok") expect(out.content).toBe(report);
      expect(ctx.lastAssistant).toBe(report);
    }
    const snapshots = onEvent.mock.calls.map(([event]) => event).filter((event) => event.type === "assistant_delta");
    expect(snapshots.at(-1)?.text).toBe(report);
    expect(chatCompletionStream).toHaveBeenCalledTimes(2);
  });
});
