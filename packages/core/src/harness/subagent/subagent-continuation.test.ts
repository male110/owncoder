/**
 * Explore 子代理续接机制测试（对齐 ZCode SendMessage：
 * 「continue a previously spawned agent with its context intact」）。
 *
 * 锁住的语义：
 * - runExploreSubagent 带 initialMessages：跳过系统提示/导航块构建，
 *   runAgentLoop 收到 initialMessages，返回 {report, transcript: agentMessages}
 * - resolveContinuation：仅 Explore 可续接；未知 id / 非 Explore 拒绝且带原因；
 *   无 continueAgentId 为 fresh
 * - executeTool 透传 continueAgentId 到 dispatchSubagent 请求
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "@owncoder/llm";
import type { IndexClient } from "@owncoder/index";
import { runExploreSubagent, resolveContinuation } from "./run-subagent.ts";
import type { AgentLoopResult } from "../loop/types.ts";

vi.mock("../loop.ts", () => ({
  runAgentLoop: vi.fn(),
}));
vi.mock("../../git.ts", () => ({
  isGitRepo: vi.fn(async () => false),
}));

import { runAgentLoop } from "../loop.ts";
const mockedRunAgentLoop = vi.mocked(runAgentLoop);

function deps() {
  return {
    workspaceRoot: "/tmp/ws",
    sessionId: "sess-cont",
    workflow: {} as never,
    mode: "agent" as const,
    index: {} as IndexClient,
    llmApiKey: "test-key",
  };
}

const TRANSCRIPT: ChatMessage[] = [
  { role: "system", content: "You are OwnCoder Explore…" },
  { role: "user", content: "首次任务" },
  { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: "{}" } }] },
  { role: "tool", tool_call_id: "c1", name: "read_file", content: "文件内容" },
];

beforeEach(() => {
  vi.clearAllMocks();
  mockedRunAgentLoop.mockResolvedValue({
    assistantText: "## Final Report\n\n续接回答",
    agentMessages: [...TRANSCRIPT, { role: "assistant", content: "## Final Report\n\n续接回答" }],
  } as AgentLoopResult);
});

describe("runExploreSubagent — 续接种子", () => {
  it("initialMessages 透传给 runAgentLoop；不再重建系统提示与导航块", async () => {
    const run = await runExploreSubagent(
      { agentType: "Explore", task: "追问首次任务里读到的分支", initialMessages: TRANSCRIPT },
      deps(),
    );
    const opts = mockedRunAgentLoop.mock.calls[0]![0];
    // 种子原样成为循环的初始消息；新任务由 loop 追加（不由这里拼接）
    expect(opts.initialMessages).toBe(TRANSCRIPT);
    expect(opts.systemPromptOverride).toBeUndefined();
    expect(opts.userMessage).toBe("追问首次任务里读到的分支");
    expect(opts.leanPipeline).toBe(true);
    expect(opts.exploreLoop).toBe(true);
    // 返回结构：报告 + 可注册的转录
    expect(run.report).toContain("续接回答");
    expect(run.transcript?.length).toBe(TRANSCRIPT.length + 1);
    expect(run.transcript?.at(-1)).toMatchObject({ role: "assistant" });
  });

  it("续接轮仍扣共享预算并在受限时给出 partial 标注", async () => {
    mockedRunAgentLoop.mockResolvedValueOnce({
      assistantText: "部分发现…",
      blocked: true,
      blockedReason: "reached the iteration limit",
      agentMessages: TRANSCRIPT,
    } as AgentLoopResult);
    const run = await runExploreSubagent(
      { agentType: "Explore", task: "继续查", initialMessages: TRANSCRIPT },
      deps(),
    );
    expect(run.report.startsWith("[Explore partial result")).toBe(true);
    expect(run.transcript).toBeDefined();
  });
});

describe("resolveContinuation — 续接解析", () => {
  const threads = new Map<string, ChatMessage[]>([["explore-1", TRANSCRIPT]]);

  it("无 continueAgentId → fresh（全新派发）", () => {
    expect(resolveContinuation({ agentType: "Explore" }, threads)).toEqual({ kind: "fresh" });
  });

  it("Explore 命中已注册线程 → 续接，种子为该线程转录", () => {
    const res = resolveContinuation({ agentType: "Explore", continueAgentId: "explore-1" }, threads);
    expect(res.kind).toBe("continue");
    if (res.kind === "continue") expect(res.initialMessages).toBe(TRANSCRIPT);
  });

  it("未知 id → 拒绝且不静默新起", () => {
    const res = resolveContinuation({ agentType: "Explore", continueAgentId: "explore-99" }, threads);
    expect(res.kind).toBe("refused");
    if (res.kind === "refused") {
      expect(res.message).toContain("unknown continueAgentId \"explore-99\"");
      expect(res.message).toContain("dispatch a fresh agent without it");
    }
  });

  it("Planner 不可续接（结构性一次性）", () => {
    const res = resolveContinuation({ agentType: "Planner", continueAgentId: "explore-1" }, threads);
    expect(res.kind).toBe("refused");
    if (res.kind === "refused") expect(res.message).toContain('not "Planner"');
  });
});
