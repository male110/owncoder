import { beforeEach, describe, expect, it, vi } from "vitest";
import { assertLlmAuth, chatCompletionStream } from "@owncoder/llm";
import { BUILTIN_WORKFLOW, BUILTIN_SPEC_TASK_DECOMPOSE_PROMPT } from "@owncoder/settings";
import { contextBudgets } from "../../../budget.ts";
import { Tracer } from "../../../observability.ts";
import { MemoryManager } from "../../../memory.ts";
import { createReasoningTrace } from "../../../agent-reasoning.ts";
import { taskDecomposeHandler } from "../task-decompose.ts";
import type { StageHandlerContext } from "../types.ts";

vi.mock("@owncoder/llm", async (original) => ({
  ...await original<typeof import("@owncoder/llm")>(),
  assertLlmAuth: vi.fn(),
  chatCompletionStream: vi.fn(),
  writeEventLog: vi.fn(),
}));
vi.mock("../decompose-context.ts", () => ({ buildDecomposeContext: vi.fn().mockResolvedValue("") }));
vi.mock("../../../model-coordinator.ts", async (original) => ({
  ...await original<typeof import("../../../model-coordinator.ts")>(),
  withRetry: async (fn: () => Promise<unknown>) => ({ result: await fn(), retries: 0 }),
}));

function context(signal?: AbortSignal) {
  const onEvent = vi.fn();
  const ctx = {
    opts: {
      workspaceRoot: ".", userMessage: "你好", history: [], attachments: [],
      mode: "agent", workflow: BUILTIN_WORKFLOW, onEvent, signal,
    },
    node: { id: "decompose", type: "task_decompose", label: "任务分解" },
    tracer: new Tracer(), memory: new MemoryManager(), reasoningTrace: createReasoningTrace(),
    budgets: contextBudgets(BUILTIN_WORKFLOW), messages: [], state: { decomposeCount: 0 },
  } as unknown as StageHandlerContext;
  return { ctx, onEvent };
}

async function run(content: string, signal?: AbortSignal) {
  vi.mocked(chatCompletionStream).mockResolvedValue({ choices: [{ message: { content } }] } as never);
  const { ctx, onEvent } = context(signal);
  await taskDecomposeHandler.run(ctx);
  return { ctx, events: onEvent.mock.calls.map(([event]) => event) };
}

describe("任务分解失败事件", () => {
  beforeEach(() => vi.resetAllMocks());

  it("跨文件架构方案在不编辑代码时仍允许 Planner，普通讨论与小改不触发", async () => {
    await run(JSON.stringify({ intent: "提供架构方案", tasks: [{ id: "t1", executionGuidance: "产出方案" }] }));
    const messages = vi.mocked(chatCompletionStream).mock.calls[0][1];
    const instructions = String(messages[0]?.content);
    expect(instructions).toContain("even if the current turn delivers only a design, proposal, or execution plan and does not edit code");
    expect(instructions).toContain("cross-file core change, architectural adjustment, complex migration, or other high-impact change");
    expect(instructions).toContain("needs repository evidence and separate user approval before implementation");
    expect(instructions).toContain("ordinary conceptual discussion or explanation, a small single-file change");
    expect(instructions).toContain("already clear edit site that needs no separate approval");
    expect(instructions).toContain("## Final Report with 目标, numbered 步骤, 相关文件 backed by actual code paths and line or symbol ranges, 风险与不确定性, 验证方式");
    expect(instructions).toContain("never start editing before approval");
    expect(vi.mocked(chatCompletionStream).mock.calls[0][2]?.tools).toEqual(expect.arrayContaining([expect.objectContaining({ function: expect.objectContaining({ name: "dispatch_agent" }) })]));
  });

  it("spec 跨模块设计请求使用专用分解提示词并提供原生 Planner", async () => {
    vi.mocked(chatCompletionStream).mockResolvedValue({ choices: [{ message: { content: JSON.stringify({ intent: "设计 spec 流程改造", tasks: [{ id: "t1", executionGuidance: "给出设计方案" }] }) } }] } as never);
    const { ctx } = context();
    ctx.opts.mode = "spec";
    ctx.opts.userMessage = "spec 模式怎么改成跨模块任务分解 → ReAct？先给代码库依据的设计改造方案";
    ctx.node = { id: "decompose", type: "task_decompose", label: "理解与任务分解", prompt: BUILTIN_SPEC_TASK_DECOMPOSE_PROMPT };
    await taskDecomposeHandler.run(ctx);
    const [_, messages, options] = vi.mocked(chatCompletionStream).mock.calls[0];
    expect(String(messages[0]?.content)).toContain("# Spec Mode — Task Planning Overrides");
    expect(String(messages[0]?.content)).toContain("tracing across modules or workflow boundaries");
    expect(options?.tools).toEqual(expect.arrayContaining([expect.objectContaining({ function: expect.objectContaining({ name: "dispatch_agent" }) })]));
    expect(ctx.state.rawDecompose?.tasks[0]?.executionGuidance).toBe("给出设计方案");
  });

  it("流式调用使用 120 秒超时并保留思考增量去重", async () => {
    const controller = new AbortController();
    vi.mocked(chatCompletionStream).mockImplementationOnce(async (_model, _messages, options) => {
      options?.onThinkingDelta?.("正在分析");
      options?.onThinkingDelta?.("正在分析");
      options?.onThinkingDelta?.("正在分析任务");
      return { choices: [{ message: { content: JSON.stringify({ intent: "问候用户", tasks: [] }) } }] } as never;
    });

    const { events } = await run("", controller.signal);

    expect(chatCompletionStream).toHaveBeenCalledTimes(1);
    expect(chatCompletionStream).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(Array),
      expect.objectContaining({
        timeout: 120_000,
        signal: controller.signal,
        purpose: "task_decompose",
        thinking: { effort: "low" },
        onThinkingDelta: expect.any(Function),
      }),
    );
    expect(vi.mocked(chatCompletionStream).mock.calls[0][2]?.onDelta).toBeUndefined();
    expect(events.filter((event) => event.type === "thinking_delta")).toEqual([
      { type: "thinking_delta", text: "正在分析" },
      { type: "thinking_delta", text: "正在分析任务" },
    ]);
    expect(events.filter((event) => event.type === "task_decomposition")).toEqual([
      expect.objectContaining({ fallback: false }),
    ]);
  });

  it.each([
    ["正常任务", { intent: "完成任务", tasks: [{ id: "t1", executionGuidance: "实现功能" }] }],
    ["正常无需计划", { intent: "问候用户", tasks: [] }],
    ["旧格式", { understanding: "完成任务", steps: [{ description: "实现功能" }] }],
  ])("%s 不标记失败", async (_, answer) => {
    const { events } = await run(JSON.stringify(answer));
    expect(events.filter((e) => e.type === "task_decomposition")).toEqual([
      expect.objectContaining({ fallback: false }),
    ]);
    expect(events.some((e) => e.type === "warning" || e.type === "error")).toBe(false);
  });

  it("纯散文（无可解析 JSON）保留为兜底任务内容而非丢弃", async () => {
    const prose = "先定位登录校验入口，再补充失败分支的单元测试。";
    const { events, ctx } = await run(prose);
    expect(events.filter((e) => e.type === "task_decomposition")).toEqual([
      expect.objectContaining({ fallback: true, tasks: [expect.objectContaining({ executionGuidance: expect.stringContaining(prose) })] }),
    ]);
    expect(ctx.state.rawDecompose?.tasks[0].executionGuidance).toContain(prose);
  });

  it.each([
    ["空文本", ""],
    ["空对象", "{}"], ["空数组", "[]"], ["无意图空任务", '{"tasks":[]}'],
    ["无效结构", '{"intent":"任务","tasks":{}}'],
    ["无效任务", '{"intent":"任务","tasks":[null,{},42]}'],
    ["空任务内容", '{"intent":"任务","tasks":[{"description":"  "}]}'],
    ["明确失败", '{"ok":false,"intent":"任务","tasks":[{"description":"不可执行"}]}'],
    ["失败标记", '{"success":false,"tasks":[]}'],
    ["错误状态", '{"status":"failed","tasks":[]}'],
    ["错误详情", '{"error":"private-stack: secret","tasks":[]}'],
  ])("%s 使用安全回退且只发出一次结果", async (_, content) => {
    const { events, ctx } = await run(content);
    expect(events.filter((e) => e.type === "task_decomposition")).toEqual([
      expect.objectContaining({ fallback: true, tasks: [expect.objectContaining({ executionGuidance: expect.stringContaining("你好") })] }),
    ]);
    expect(JSON.stringify(events)).not.toContain("private-stack");
    expect(ctx.state.rawDecompose?.tasks).toHaveLength(1);
  });

  it.each(["auth", "stream"])("%s 异常返回安全失败结果而不抛出", async (source) => {
    const error = new Error("private-stack: secret");
    if (source === "auth") vi.mocked(assertLlmAuth).mockImplementationOnce(() => { throw error; });
    else vi.mocked(chatCompletionStream).mockRejectedValueOnce(error);
    const { ctx, onEvent } = context();
    await taskDecomposeHandler.run(ctx);
    const events = onEvent.mock.calls.map(([event]) => event);
    expect(events.filter((e) => e.type === "task_decomposition")).toEqual([
      expect.objectContaining({ fallback: true }),
    ]);
    expect(JSON.stringify(events)).not.toContain("private-stack");
  });

  it("用户中止不发送失败分解结果", async () => {
    const controller = new AbortController();
    controller.abort();
    const { events } = await run("", controller.signal);
    expect(events.some((e) => e.type === "task_decomposition" || e.type === "warning" || e.type === "error")).toBe(false);
  });
});
