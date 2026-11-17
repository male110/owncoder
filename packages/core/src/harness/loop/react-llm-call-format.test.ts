import { describe, expect, it, vi } from "vitest";
import { chatCompletionStream } from "@owncoder/llm";
import { callModelForIteration } from "./react-llm-call.ts";
import { isolateMessagesForNextTask } from "./task-reports.ts";
import { createLoopState, createTerminationConfig } from "./termination.ts";
import type { ReActLoopContext } from "./react-loop-context.ts";
import type { ChatMessage } from "@owncoder/llm";

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
      loopState: createLoopState(), terminationConfig: createTerminationConfig({ maxIterations: 9 }),
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
      loopState: createLoopState(), terminationConfig: createTerminationConfig({ maxIterations: 9 }),
    } as unknown as ReActLoopContext;
    vi.mocked(chatCompletionStream).mockResolvedValue({
      choices: [{ message: { role: "assistant", content: "继续" }, finish_reason: "stop" }],
    } as Awaited<ReturnType<typeof chatCompletionStream>>);
    vi.mocked(chatCompletionStream).mockClear();

    expect((await callModelForIteration(ctx, 0)).kind).toBe("ok");
    const first = vi.mocked(chatCompletionStream).mock.calls[0]!;
    const firstRequest = first[1].slice(0, -1);
    expect(firstRequest.map((message) => message.role)).toEqual(["system", "system", "system", "user"]);
    expect(firstRequest.slice(0, 2)).toEqual(messages.slice(0, 2));
    expect(firstRequest[2]?.content).toContain("Execution guidance (how to carry out this task): 处理任务一");
    expect(firstRequest[3]).toEqual(messages[2]);
    expect(first[2]?.tools).toBe(ctx.toolsFinal);
    expect(messages).toHaveLength(3);

    messages.push({ role: "assistant", content: "", tool_calls: [{ id: "call-1", type: "function", function: { name: "read_file", arguments: "{}" } }] });
    messages.push({ role: "tool", tool_call_id: "call-1", content: "文件内容" });
    expect((await callModelForIteration(ctx, 1)).kind).toBe("ok");
    const second = vi.mocked(chatCompletionStream).mock.calls[1]!;
    const secondRequest = second[1].slice(0, -1);
    expect(secondRequest.slice(0, 4)).toEqual(firstRequest);
    expect(secondRequest.slice(4)).toEqual(messages.slice(3));
    expect(second[2]?.tools).toBe(ctx.toolsFinal);
    expect(messages).toHaveLength(5);

    isolateMessagesForNextTask(messages, 3);
    ctx.currentTask = { ...ctx.currentTask!, id: "t2", executionGuidance: "处理任务二" };
    expect((await callModelForIteration(ctx, 2)).kind).toBe("ok");
    const third = vi.mocked(chatCompletionStream).mock.calls[2]!;
    const thirdRequest = third[1].slice(0, -1);
    expect(thirdRequest.slice(0, 2)).toEqual(firstRequest.slice(0, 2));
    expect(thirdRequest.map((message) => message.role)).toEqual(["system", "system", "system", "user"]);
    expect(thirdRequest[2]?.content).toContain("Execution guidance (how to carry out this task): 处理任务二");
    expect(JSON.stringify(thirdRequest)).not.toContain("处理任务一");
    expect(JSON.stringify(thirdRequest)).not.toContain("文件内容");
    expect(third[2]?.tools).toBe(ctx.toolsFinal);
  });

  it("不越过用户消息寻找系统消息，也不为无任务请求注入任务消息", async () => {
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
      loopState: createLoopState(), terminationConfig: createTerminationConfig({ maxIterations: 9 }),
    } as unknown as ReActLoopContext;
    vi.mocked(chatCompletionStream).mockResolvedValue({
      choices: [{ message: { role: "assistant", content: "完成" }, finish_reason: "stop" }],
    } as Awaited<ReturnType<typeof chatCompletionStream>>);
    vi.mocked(chatCompletionStream).mockClear();
    await callModelForIteration(ctx, 0);
    expect(vi.mocked(chatCompletionStream).mock.calls[0]![1].map((message) => message.content)).toEqual([
      "基础指令", expect.stringContaining("Execution guidance (how to carry out this task): 执行任务"), "用户请求", "后续系统消息",
      expect.stringContaining("当前第 1 次迭代，上限 9 次，剩余 8 次"),
    ]);
    ctx.currentTask = null;
    // 迭代计数由 updateStateAfterResponse 在真实循环里推进；这里直接置位对齐。
    ctx.loopState.iteration = 1;
    await callModelForIteration(ctx, 1);
    // 无当前任务时不再注入任务消息，但迭代预算提示仍然照常送达模型。
    expect(vi.mocked(chatCompletionStream).mock.calls[1]![1].map((message) => message.content)).toEqual([
      "基础指令", "用户请求", "后续系统消息",
      expect.stringContaining("当前第 2 次迭代，上限 9 次，剩余 7 次"),
    ]);
    expect(messages).toHaveLength(3);
  });

  it("每轮把当前迭代序号、上限与剩余次数作为上下文交给模型，且不写回持久消息", async () => {
    const messages = [{ role: "user", content: "用户请求" }] as ReActLoopContext["messages"];
    const ctx = {
      model: { model: "test-model" }, stageId: "react", llmMaxRetries: 0,
      messages, currentTask: null,
      opts: { sessionId: "iteration-hint-test" },
      tracer: { startSpan: vi.fn(), endSpan: vi.fn(), recordTokenUsage: vi.fn() },
      history: [], lastAssistant: "",
      loopState: createLoopState(), terminationConfig: createTerminationConfig({ maxIterations: 3 }),
    } as unknown as ReActLoopContext;
    vi.mocked(chatCompletionStream).mockResolvedValue({
      choices: [{ message: { role: "assistant", content: "继续" }, finish_reason: "stop" }],
    } as Awaited<ReturnType<typeof chatCompletionStream>>);
    vi.mocked(chatCompletionStream).mockClear();

    const hintOf = (call: number): string =>
      String((vi.mocked(chatCompletionStream).mock.calls[call]![1] as ChatMessage[]).at(-1)?.content ?? "");

    await callModelForIteration(ctx, 0);
    expect(hintOf(0)).toContain("当前第 1 次迭代，上限 3 次，剩余 2 次");

    // 第 2 轮：loopState.iteration 由 updateStateAfterResponse 递增，与终止判定同源。
    ctx.loopState.iteration = 1;
    await callModelForIteration(ctx, 1);
    expect(hintOf(1)).toContain("当前第 2 次迭代，上限 3 次，剩余 1 次");

    // 最后一轮：剩余 0，提示改为强制收尾指令（不得再调用工具、必须直接
    // 输出最终计划/结论），且不与终态文案“已达到最大迭代限制”重复。
    ctx.loopState.iteration = 2;
    await callModelForIteration(ctx, 2);
    const last = hintOf(2);
    expect(last).toContain("当前第 3 次迭代，上限 3 次，剩余 0 次");
    expect(last).toContain("这是最后一次迭代");
    expect(last).toContain("不得再调用任何工具");
    expect(last).toContain("必须直接输出最终计划/结论文本");
    expect(last).not.toContain("请据此安排工具调用预算");
    expect(last).not.toContain("已达到最大迭代限制");

    // 提示只作用于当轮请求，不进入持久消息与历史，避免逐轮累加。
    expect(messages).toEqual([{ role: "user", content: "用户请求" }]);
    expect(ctx.history).toEqual([]);
  });
});
