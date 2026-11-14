/**
 * runTaskDecompose 的 relevantHistory 本地兜底接线测试。
 *
 * 锁住的语义：
 * - 分解 LLM 漏填 relevantHistory → packFallbackRelevantHistory 兜底打包
 *   本轮已读证据（含文件路径），rawDecompose.relevantHistory 非空
 * - 分解 LLM 填了 relevantHistory → 原值保留，兜底不触发
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chatCompletionStream } from "@owncoder/llm";
import { BUILTIN_WORKFLOW } from "@owncoder/settings";
import { runTaskDecompose, taskDecomposeHandler } from "../task-decompose.ts";
import { builtinAgentPipeline } from "@owncoder/settings";
import type { StageHandlerContext } from "../types.ts";
import { contextBudgets } from "../../../budget.ts";
import { Tracer } from "../../../observability.ts";
import { createReasoningTrace } from "../../../agent-reasoning.ts";
import { MemoryManager } from "../../../memory.ts";
import type { AgentLoopOpts, ChatTurn } from "../../types.ts";

vi.mock("@owncoder/llm", async (importOriginal) => ({
  ...await importOriginal<typeof import("@owncoder/llm")>(),
  assertLlmAuth: vi.fn(),
  chatCompletionStream: vi.fn(),
  writeEventLog: vi.fn(),
}));

const mockedStream = vi.mocked(chatCompletionStream);

/** 分解 LLM 返回的 JSON（可控制是否带 relevantHistory）。 */
function decomposeJson(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    intent: "修复 validateToken 的登录失败",
    userConstraints: [],
    tasks: [
      { id: "t1", title: "定位", description: "定位 validateToken 抛错点", prompt: "从 validateToken 入手", dependsOn: [] },
    ],
    ...extra,
  });
}

/** 一条带已读证据的历史（read_file 工具结果，带 summarizeToolResultForHistory 的头部）。 */
const evidenceHistory: ChatTurn[] = [
  { role: "user", content: "上一轮：排查 UserService 登录失败" },
  {
    role: "tool",
    toolName: "read_file",
    content: "Read src/auth.ts (lines 1-10 of 200)\n1 export class UserService {\n2   validateToken(token: string) {\n3     // 验签逻辑\n4   }\n5 }",
  },
  { role: "assistant", content: "结论：validateToken 验签抛错" },
];

function makeOpts(history: ChatTurn[], workspaceRoot: string): AgentLoopOpts {
  return {
    workspaceRoot,
    sessionId: "sess-fallback-test",
    userMessage: "排查 UserService 的 validateToken 为什么抛错",
    history,
    mode: "agent",
    workflow: BUILTIN_WORKFLOW,
    llmApiKey: "test-key",
    index: {} as never,
    attachments: [],
  } as unknown as AgentLoopOpts;
}

describe("runTaskDecompose — relevantHistory 本地兜底", () => {
  let tmpDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    tmpDir = await fs.mkdtemp(join(tmpdir(), "decompose-fallback-"));
  });

  it("分解 LLM 漏填 relevantHistory → 兜底打包已读证据（含路径）", async () => {
    // withRetry 会把 chatCompletionStream 的解析值包成 { result, retries }，
    // 这里直接给聊天完成形状（choices[0].message.content）。
    mockedStream.mockResolvedValue({
      choices: [{ message: { content: decomposeJson() } }],
    } as never);

    const result = await runTaskDecompose(
      makeOpts(evidenceHistory, tmpDir),
      {} as never,
      new Tracer(),
      new MemoryManager(),
      createReasoningTrace(),
      contextBudgets(BUILTIN_WORKFLOW),
    );

    expect(result.fallback).toBe(false);
    expect(result.rawDecompose).toBeDefined();
    // 兜底生效：relevantHistory 非空且含证据文件路径
    expect(result.rawDecompose!.relevantHistory).toContain("src/auth.ts");
    expect(result.rawDecompose!.relevantHistory).toContain("UserService");
  });

  it("模型未调用工具时沿用原任务 JSON，不读取伪装字段", async () => {
    mockedStream.mockResolvedValue({ choices: [{ message: { content: decomposeJson({ plannerDecision: "plan" }) } }] } as never);
    const result = await runTaskDecompose(
      makeOpts([], tmpDir), {} as never, new Tracer(), new MemoryManager(), createReasoningTrace(), contextBudgets(BUILTIN_WORKFLOW),
    );
    expect(vi.mocked(chatCompletionStream).mock.calls.at(-1)?.[2]?.tools?.map((tool) => tool.function.name)).toEqual(["dispatch_agent"]);
    expect(result.planToolCall).toBeUndefined();
    expect(result.rawDecompose?.tasks[0]?.id).toBe("t1");
    expect(result.fallback).toBe(false);
  });

  it("只读或禁用子代理的角色不会收到计划工具", async () => {
    mockedStream.mockResolvedValue({ choices: [{ message: { content: decomposeJson() } }] } as never);
    const readOnly = { ...makeOpts([], tmpDir), readOnly: true };
    await runTaskDecompose(readOnly, {} as never, new Tracer(), new MemoryManager(), createReasoningTrace(), contextBudgets(BUILTIN_WORKFLOW));
    expect(mockedStream.mock.calls.at(-1)?.[2]?.tools).toBeUndefined();
    const restricted = { ...makeOpts([], tmpDir), allowedTools: ["read_file"] };
    await runTaskDecompose(restricted, {} as never, new Tracer(), new MemoryManager(), createReasoningTrace(), contextBudgets(BUILTIN_WORKFLOW));
    expect(mockedStream.mock.calls.at(-1)?.[2]?.tools).toBeUndefined();
  });

  it("模型原生工具调用优先于同时返回的任务 JSON", async () => {
    const call = { id: "call-1", type: "function", function: { name: "dispatch_agent", arguments: JSON.stringify({ task: "只读制定计划" }) } };
    mockedStream.mockResolvedValue({ choices: [{ message: { content: decomposeJson(), tool_calls: [call] } }] } as never);
    const result = await runTaskDecompose(
      makeOpts([], tmpDir), {} as never, new Tracer(), new MemoryManager(), createReasoningTrace(), contextBudgets(BUILTIN_WORKFLOW),
    );
    expect(result.planToolCall).toEqual(call);
    expect(result.rawDecompose).toBeUndefined();
  });

  it("只读子代理审批后完整计划重新进入任务分解，并发布普通任务给 ReAct", async () => {
    const call = { id: "call-1", type: "function", function: { name: "dispatch_agent", arguments: JSON.stringify({ task: "只读制定计划" }) } };
    mockedStream.mockResolvedValueOnce({ choices: [{ message: { content: "", tool_calls: [call] } }] } as never)
      .mockResolvedValueOnce({ choices: [{ message: { content: decomposeJson() } }] } as never);
    const report = ["## Final Report", "### 目标", "修复问题", "### 步骤", "1. 修复并测试", "### 相关文件", "src/auth.ts", "### 风险与不确定性", "无", "### 验证方式", "运行测试"].join("\n");
    const approval = vi.fn().mockResolvedValue("approve");
    const dispatch = vi.fn().mockResolvedValue(report);
    const ctx = {
      opts: { ...makeOpts([], tmpDir), askUser: approval, onEvent: vi.fn() },
      node: builtinAgentPipeline().nodes.find((node) => node.type === "task_decompose"),
      tracer: new Tracer(), memory: new MemoryManager(), reasoningTrace: createReasoningTrace(),
      budgets: contextBudgets(BUILTIN_WORKFLOW), messages: [], history: [],
      toolCtx: { workflow: BUILTIN_WORKFLOW, availableTools: new Set(["dispatch_agent"]), dispatchSubagent: dispatch },
      state: { decomposeCount: 0, decomposeTokens: 0, blocked: false, aborted: false },
    } as unknown as StageHandlerContext;
    await taskDecomposeHandler.run(ctx);
    expect(dispatch).toHaveBeenCalledOnce();
    expect(approval).toHaveBeenCalledOnce();
    expect(ctx.state.approvedAgentPlan).toBe(report);
    expect(ctx.opts.userMessage).toBe(report);
    expect(mockedStream).toHaveBeenCalledTimes(2);
    expect(mockedStream.mock.calls[1]?.[1][1]?.content).toContain(report);
    expect(mockedStream.mock.calls[1]?.[2]?.tools).toBeUndefined();
    expect(ctx.state.rawDecompose?.tasks[0]?.id).toBe("t1");
    expect(ctx.opts.onEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "task_decomposition", tasks: [expect.objectContaining({ id: "t1" })] }));
  });

  it("拒绝计划时不会重新分解或发布任务", async () => {
    const call = { id: "call-1", type: "function", function: { name: "dispatch_agent", arguments: JSON.stringify({ task: "只读制定计划" }) } };
    mockedStream.mockResolvedValueOnce({ choices: [{ message: { content: "", tool_calls: [call] } }] } as never);
    const report = ["## Final Report", "### 目标", "修复问题", "### 步骤", "1. 修复并测试", "### 相关文件", "src/auth.ts", "### 风险与不确定性", "无", "### 验证方式", "运行测试"].join("\n");
    const ctx = {
      opts: { ...makeOpts([], tmpDir), askUser: vi.fn().mockResolvedValue("reject"), onEvent: vi.fn() },
      node: builtinAgentPipeline().nodes.find((node) => node.type === "task_decompose"),
      tracer: new Tracer(), memory: new MemoryManager(), reasoningTrace: createReasoningTrace(),
      budgets: contextBudgets(BUILTIN_WORKFLOW), messages: [], history: [],
      toolCtx: { workflow: BUILTIN_WORKFLOW, availableTools: new Set(["dispatch_agent"]), dispatchSubagent: vi.fn().mockResolvedValue(report) },
      state: { decomposeCount: 0, decomposeTokens: 0, blocked: false, aborted: false },
    } as unknown as StageHandlerContext;
    await taskDecomposeHandler.run(ctx);
    expect(ctx.state.blocked).toBe(true);
    expect(ctx.opts.userMessage).not.toBe(report);
    expect(ctx.state.rawDecompose).toBeUndefined();
    expect(mockedStream).toHaveBeenCalledOnce();
    expect(ctx.opts.onEvent).not.toHaveBeenCalledWith(expect.objectContaining({ type: "task_decomposition" }));
  });

  it("无效或多个原生工具调用阻断执行且不调用子代理", async () => {
    mockedStream.mockResolvedValue({ choices: [{ message: { content: decomposeJson(), tool_calls: [
      { id: "1", type: "function", function: { name: "dispatch_agent", arguments: "{}" } },
      { id: "2", type: "function", function: { name: "dispatch_agent", arguments: "{}" } },
    ] } }] } as never);
    const dispatch = vi.fn();
    const ctx = {
      opts: makeOpts([], tmpDir), node: builtinAgentPipeline().nodes.find((node) => node.type === "task_decompose"),
      tracer: new Tracer(), memory: new MemoryManager(), reasoningTrace: createReasoningTrace(),
      budgets: contextBudgets(BUILTIN_WORKFLOW), messages: [], history: [],
      toolCtx: { availableTools: new Set(["dispatch_agent"]), dispatchSubagent: dispatch },
      state: { decomposeCount: 0, decomposeTokens: 0, blocked: false, aborted: false },
    } as unknown as StageHandlerContext;
    await taskDecomposeHandler.run(ctx);
    expect(ctx.state.blocked).toBe(true);
    expect(dispatch).not.toHaveBeenCalled();
    expect(ctx.state.rawDecompose).toBeUndefined();
  });

  it("fallback evidence is bounded even when one read is huge", async () => {
    const hugeHistory: ChatTurn[] = [
      { role: "tool", toolName: "read_file", content: `Read src/auth.ts (lines 1-900 of 900)\\n${"validateToken ".repeat(5000)}` },
    ];
    mockedStream.mockResolvedValue({ choices: [{ message: { content: decomposeJson() } }] } as never);
    const result = await runTaskDecompose(
      makeOpts(hugeHistory, tmpDir), {} as never, new Tracer(), new MemoryManager(), createReasoningTrace(), contextBudgets(BUILTIN_WORKFLOW),
    );
    expect(result.rawDecompose!.relevantHistory!.length).toBeLessThanOrEqual(32_000);
    expect(result.rawDecompose!.relevantHistory).toContain("evidence clipped");
  });

  it("分解 LLM 填了 relevantHistory → 原值保留，兜底不触发", async () => {
    mockedStream.mockResolvedValue({
      choices: [{ message: { content: decomposeJson({ relevantHistory: "LLM 自己写的历史结论" }) } }],
    } as never);

    const result = await runTaskDecompose(
      makeOpts(evidenceHistory, tmpDir),
      {} as never,
      new Tracer(),
      new MemoryManager(),
      createReasoningTrace(),
      contextBudgets(BUILTIN_WORKFLOW),
    );

    expect(result.rawDecompose!.relevantHistory).toBe("LLM 自己写的历史结论");
  });
});
