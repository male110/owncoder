import { beforeEach, describe, expect, it, vi } from "vitest";
import { BUILTIN_WORKFLOW, builtinPlanPipeline, builtinAgentPipeline } from "@owncoder/settings";
import { contextBudgets } from "../../../budget.ts";
import { injectHistoryAndUserMessage } from "../index.ts";
import type { SchedulerContext } from "../types.ts";
import type { ChatTurn } from "../../types.ts";

vi.mock("@owncoder/llm", async (importOriginal) => ({
  ...await importOriginal<typeof import("@owncoder/llm")>(),
  writeEventLog: vi.fn(),
}));

function makeContext(mode: "plan" | "agent", history: ChatTurn[]): SchedulerContext {
  return {
    opts: {
      mode,
      workspaceRoot: process.cwd(),
      workflow: BUILTIN_WORKFLOW,
      userMessage: "继续处理",
      history,
    },
    history: [...history],
    messages: [],
    state: {
      userMessageInjected: false,
      turnInformationTask: null,
    },
    model: { model: "test-model" },
    budgets: contextBudgets(BUILTIN_WORKFLOW),
    tracer: { startSpan: vi.fn(), endSpan: vi.fn(), recordTokenUsage: vi.fn() },
    memory: {},
    reasoningTrace: { steps: [] },
  } as unknown as SchedulerContext;
}

describe("plan 模式历史对话传递", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("多轮对话作为只读历史放在当前请求之前", async () => {
    const history: ChatTurn[] = [
      { role: "user", content: "第一轮问题" },
      { role: "assistant", content: "第一轮结论" },
      { role: "user", content: "第二轮问题" },
      { role: "assistant", content: "第二轮结论" },
    ];
    const ctx = makeContext("plan", history);
    await injectHistoryAndUserMessage(ctx);

    // 历史块 + 当前用户消息，共两条 user 消息
    const userMessages = ctx.messages.filter((m) => m.role === "user");
    expect(userMessages).toHaveLength(2);

    const [historyMsg, currentMsg] = userMessages;
    // 历史块带 conversation_history 标签，包含此前各轮
    expect(historyMsg.content).toContain("<conversation_history>");
    expect(historyMsg.content).toContain("第一轮问题");
    expect(historyMsg.content).toContain("第一轮结论");
    expect(historyMsg.content).toContain("第二轮问题");
    expect(historyMsg.content).toContain("第二轮结论");

    // 当前请求在历史之后
    expect(currentMsg.content).toContain("继续处理");
    expect(ctx.messages.indexOf(historyMsg)).toBeLessThan(ctx.messages.indexOf(currentMsg));
  });

  it("历史中的工具执行结果不注入，仅保留活动标记", async () => {
    const history: ChatTurn[] = [
      { role: "user", content: "查找问题" },
      { role: "tool", content: "大段工具返回内容 SECRET", toolName: "read_file" },
      { role: "assistant", content: "找到问题" },
    ];
    const ctx = makeContext("plan", history);
    await injectHistoryAndUserMessage(ctx);

    const historyMsg = ctx.messages.find((m) => (m.content ?? "").includes("conversation_history"))!;
    expect(historyMsg.content).toContain("read_file");
    expect(historyMsg.content).not.toContain("大段工具返回内容 SECRET");
  });

  it("无历史时不推送历史块，仅注入当前用户消息", async () => {
    const ctx = makeContext("plan", []);
    await injectHistoryAndUserMessage(ctx);

    const userMessages = ctx.messages.filter((m) => m.role === "user");
    expect(userMessages).toHaveLength(1);
    expect(userMessages[0].content).toContain("继续处理");
    expect(userMessages[0].content).not.toContain("<conversation_history>");
  });

  it("agent 模式不直接注入历史块（历史由任务分解阶段消化）", async () => {
    const history: ChatTurn[] = [
      { role: "user", content: "第一轮问题" },
      { role: "assistant", content: "第一轮结论" },
    ];
    const ctx = makeContext("agent", history);
    await injectHistoryAndUserMessage(ctx);

    const userMessages = ctx.messages.filter((m) => m.role === "user");
    expect(userMessages).toHaveLength(1);
    expect(userMessages[0].content).toContain("继续处理");
    expect(userMessages[0].content).not.toContain("<conversation_history>");
    expect(userMessages[0].content).not.toContain("第一轮问题");
  });

  it("plan pipeline 不包含 task_decompose 节点", () => {
    const plan = builtinPlanPipeline();
    expect(plan.nodes.some((n) => n.type === "task_decompose")).toBe(false);
  });

  it("agent pipeline 仍保留 task_decompose 节点", () => {
    const agent = builtinAgentPipeline();
    expect(agent.nodes.some((n) => n.type === "task_decompose")).toBe(true);
  });
});
