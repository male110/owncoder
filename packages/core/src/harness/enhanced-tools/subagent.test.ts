/**
 * dispatch_agent 工具端到端测试：relevantHistory 参数从工具参数流入子代理系统提示。
 *
 * 锁住的语义：
 * - 传入 relevantHistory → 请求携带原值 → 系统提示出现「任务分解阶段相关历史」背景块
 * - 缺失或空白 → 请求不带 relevantHistory（planner.ts 自动注入 / loop.ts 兜底路径不受影响），
 *   loop.ts 式兜底（activeTasks 首个非空）仍能注入；无兜底时不产生空占位段落
 * - schema 中 relevantHistory 为可选参数，不得进入 required
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IndexClient } from "@owncoder/index";
import { executeTool } from "../execute.ts";
import type { ToolContext } from "../tools/types.ts";
import { DISPATCH_AGENT_TOOL_DEF } from "./subagent.ts";
import { runExploreSubagent } from "../subagent/run-subagent.ts";
import type { DispatchSubagentRequest } from "../subagent/run-subagent.ts";
import type { AgentLoopResult } from "../loop/types.ts";

vi.mock("../loop.ts", () => ({
  runAgentLoop: vi.fn(),
}));
vi.mock("../../git.ts", () => ({
  isGitRepo: vi.fn(async () => false),
}));

import { runAgentLoop } from "../loop.ts";
const mockedRunAgentLoop = vi.mocked(runAgentLoop);

function call(args: Record<string, unknown>) {
  return { id: "call-1", name: "dispatch_agent", arguments: args, rawArguments: JSON.stringify(args) };
}

const emptyIndex = { ftsSearch: vi.fn(async () => []) } as unknown as IndexClient;

function deps() {
  return {
    workspaceRoot: "/tmp/ws",
    sessionId: "sess-e2e",
    workflow: {} as never,
    mode: "agent" as const,
    index: emptyIndex,
    llmApiKey: "test-key",
  };
}

/** 复刻 loop.ts L296-299 的兜底：请求未带非空历史时取 activeTasks 首个非空值。 */
function withLoopFallback(request: DispatchSubagentRequest, activeTasks?: { relevantHistory?: string }[]) {
  const relevantHistory = request.relevantHistory?.trim()
    ? request.relevantHistory
    : activeTasks?.find((task) => task.relevantHistory?.trim())?.relevantHistory;
  return runExploreSubagent({ ...request, relevantHistory }, deps());
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedRunAgentLoop.mockResolvedValue({
    assistantText: "## Final Report\n\n结论：登录失败",
  } as AgentLoopResult);
});

describe("dispatch_agent — relevantHistory 端到端", () => {
  it("任务分解相关历史随工具参数透传到子代理系统提示背景块", async () => {
    const requestSpy = vi.fn((request: DispatchSubagentRequest) => runExploreSubagent(request, deps()));
    const ctx = { dispatchSubagent: requestSpy, workflow: {} } as unknown as ToolContext;
    const result = await executeTool(ctx, call({
      agent_type: "Explore",
      task: "检查实现",
      relevantHistory: "src/auth.ts:42 已确认 validateToken 入口",
    }));
    expect(result.ok).toBe(true);
    expect(requestSpy.mock.calls[0]![0].relevantHistory).toBe("src/auth.ts:42 已确认 validateToken 入口");
    const prompt = mockedRunAgentLoop.mock.calls[0]![0].systemPromptOverride as string;
    expect(prompt).toContain("任务分解阶段相关历史");
    expect(prompt).toContain("src/auth.ts:42 已确认 validateToken 入口");
    expect(prompt).toContain("不是当前指令");
  });

  it.each([
    { label: "参数缺失", args: {} },
    { label: "空字符串", args: { relevantHistory: "" } },
    { label: "纯空白", args: { relevantHistory: "   " } },
  ])("$label：请求不带历史，兜底注入行为不变", async ({ args }) => {
    const requestSpy = vi.fn((request: DispatchSubagentRequest) =>
      withLoopFallback(request, [{ relevantHistory: "activeTasks 兜底历史" }]));
    const ctx = { dispatchSubagent: requestSpy, workflow: {} } as unknown as ToolContext;
    const result = await executeTool(ctx, call({ agent_type: "Explore", task: "检查实现", ...args }));
    expect(result.ok).toBe(true);
    // 请求不带 relevantHistory，planner.ts 自动注入与 loop.ts 兜底仍按原逻辑生效
    expect(requestSpy.mock.calls[0]![0].relevantHistory).toBeUndefined();
    const prompt = mockedRunAgentLoop.mock.calls[0]![0].systemPromptOverride as string;
    expect(prompt).toContain("任务分解阶段相关历史");
    expect(prompt).toContain("activeTasks 兜底历史");
  });

  it("参数缺失且无兜底历史：不产生空占位段落", async () => {
    const requestSpy = vi.fn((request: DispatchSubagentRequest) => withLoopFallback(request, undefined));
    const ctx = { dispatchSubagent: requestSpy, workflow: {} } as unknown as ToolContext;
    const result = await executeTool(ctx, call({ agent_type: "Explore", task: "检查实现" }));
    expect(result.ok).toBe(true);
    expect(requestSpy.mock.calls[0]![0].relevantHistory).toBeUndefined();
    const prompt = mockedRunAgentLoop.mock.calls[0]![0].systemPromptOverride as string;
    expect(prompt).not.toContain("任务分解阶段相关历史");
  });

  it("schema 暴露可选 relevantHistory 参数，required 不变", () => {
    const params = DISPATCH_AGENT_TOOL_DEF.function.parameters as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(params.properties.relevantHistory).toBeDefined();
    expect(params.required).toEqual(["task"]);
  });
});

describe("dispatch_agent — Planner 派发入口收敛", () => {
  it("executeTool 层放行 Planner：任务分解的 runAgentPlanner 经此派发（ReAct 入口另有硬拦截）", async () => {
    const requestSpy = vi.fn(async () => "## Final Report");
    const ctx = { dispatchSubagent: requestSpy, workflow: {} } as unknown as ToolContext;
    const result = await executeTool(ctx, call({ agent_type: "Planner", task: "生成执行计划" }));
    expect(result.ok).toBe(true);
    expect(requestSpy).toHaveBeenCalledTimes(1);
  });

  it('agent_type="Explore" 不受影响，正常派发', async () => {
    const requestSpy = vi.fn((request: DispatchSubagentRequest) => runExploreSubagent(request, deps()));
    const ctx = { dispatchSubagent: requestSpy, workflow: {} } as unknown as ToolContext;
    const result = await executeTool(ctx, call({ agent_type: "Explore", task: "检查实现" }));
    expect(result.ok).toBe(true);
    expect(requestSpy).toHaveBeenCalledTimes(1);
  });

  it("schema 的 agent_type enum 不再暴露 Planner", () => {
    const params = DISPATCH_AGENT_TOOL_DEF.function.parameters as {
      properties: { agent_type: { enum: string[] } };
    };
    expect(params.properties.agent_type.enum).toEqual(["Explore"]);
  });
});
