import { describe, expect, it, vi } from "vitest";
import { chatCompletionStream } from "@owncoder/llm";
import { callModelForIteration } from "./react-llm-call.ts";
import { isolateMessagesForNextTask } from "./task-reports.ts";
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
      currentTask: { id: "format", executionGuidance: "分析 @EnumValue 与 @JsonValue 的项目使用规范", status: "in_progress", dependsOn: [], retryCount: 0, maxRetries: 2 },
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

  it("连续轮次保留完整系统前缀、当前任务优先于用户和工具对话，且不修改原消息", async () => {
    const messages = [
      { role: "system", content: "基础指令" },
      { role: "system", content: "平台与项目上下文" },
      { role: "user", content: "用户请求" },
    ] as ReActLoopContext["messages"];
    const ctx = {
      model: { model: "test-model" }, stageId: "react", llmMaxRetries: 0,
      messages, currentTask: { id: "t1", executionGuidance: "处理任务一", status: "in_progress", dependsOn: [], retryCount: 0, maxRetries: 2 },
      toolsFinal: [{ type: "function", function: { name: "read_file", description: "读取文件", parameters: {} } }],
      opts: { sessionId: "cache-test" },
      tracer: { startSpan: vi.fn(), endSpan: vi.fn(), recordTokenUsage: vi.fn() },
      history: [], lastAssistant: "",
    } as unknown as ReActLoopContext;
    vi.mocked(chatCompletionStream).mockResolvedValue({
      choices: [{ message: { role: "assistant", content: "继续" }, finish_reason: "stop" }],
    } as Awaited<ReturnType<typeof chatCompletionStream>>);
    vi.mocked(chatCompletionStream).mockClear();

    expect((await callModelForIteration(ctx, 0)).kind).toBe("ok");
    const first = vi.mocked(chatCompletionStream).mock.calls[0]!;
    expect(first[1].map((message) => message.role)).toEqual(["system", "system", "system", "user"]);
    expect(first[1].slice(0, 2)).toEqual(messages.slice(0, 2));
    expect(first[1][2]?.content).toContain("Execution guidance (how to carry out this task): 处理任务一");
    expect(first[1][3]).toEqual(messages[2]);
    expect(first[2]?.tools).toBe(ctx.toolsFinal);
    expect(messages).toHaveLength(3);

    messages.push({ role: "assistant", content: "", tool_calls: [{ id: "call-1", type: "function", function: { name: "read_file", arguments: "{}" } }] });
    messages.push({ role: "tool", tool_call_id: "call-1", content: "文件内容" });
    expect((await callModelForIteration(ctx, 1)).kind).toBe("ok");
    const second = vi.mocked(chatCompletionStream).mock.calls[1]!;
    expect(second[1].slice(0, 4)).toEqual(first[1]);
    expect(second[1].slice(4)).toEqual(messages.slice(3));
    expect(second[2]?.tools).toBe(ctx.toolsFinal);
    expect(messages).toHaveLength(5);

    isolateMessagesForNextTask(messages, 3);
    ctx.currentTask = { ...ctx.currentTask!, id: "t2", executionGuidance: "处理任务二" };
    expect((await callModelForIteration(ctx, 2)).kind).toBe("ok");
    const third = vi.mocked(chatCompletionStream).mock.calls[2]!;
    expect(third[1].slice(0, 2)).toEqual(first[1].slice(0, 2));
    expect(third[1].map((message) => message.role)).toEqual(["system", "system", "system", "user"]);
    expect(third[1][2]?.content).toContain("Execution guidance (how to carry out this task): 处理任务二");
    expect(JSON.stringify(third[1])).not.toContain("处理任务一");
    expect(JSON.stringify(third[1])).not.toContain("文件内容");
    expect(third[2]?.tools).toBe(ctx.toolsFinal);
  });

  it("不越过用户消息寻找系统消息，也不为无任务请求注入消息", async () => {
    const messages = [
      { role: "system", content: "基础指令" },
      { role: "user", content: "用户请求" },
      { role: "system", content: "后续系统消息" },
    ] as ReActLoopContext["messages"];
    const ctx = {
      model: { model: "test-model" }, stageId: "react", llmMaxRetries: 0,
      messages, currentTask: { id: "t1", executionGuidance: "执行任务", status: "in_progress", dependsOn: [], retryCount: 0, maxRetries: 2 },
      opts: { sessionId: "cache-test" },
      tracer: { startSpan: vi.fn(), endSpan: vi.fn(), recordTokenUsage: vi.fn() },
      history: [], lastAssistant: "",
    } as unknown as ReActLoopContext;
    vi.mocked(chatCompletionStream).mockResolvedValue({
      choices: [{ message: { role: "assistant", content: "完成" }, finish_reason: "stop" }],
    } as Awaited<ReturnType<typeof chatCompletionStream>>);
    vi.mocked(chatCompletionStream).mockClear();
    await callModelForIteration(ctx, 0);
    expect(vi.mocked(chatCompletionStream).mock.calls[0]![1].map((message) => message.content)).toEqual([
      "基础指令", expect.stringContaining("Execution guidance (how to carry out this task): 执行任务"), "用户请求", "后续系统消息",
    ]);
    ctx.currentTask = null;
    await callModelForIteration(ctx, 1);
    expect(vi.mocked(chatCompletionStream).mock.calls[1]![1]).toBe(messages);
  });
});
