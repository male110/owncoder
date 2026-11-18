/**
 * runExploreSubagent 索引导航引导块（检索优先探索起点）测试。
 *
 * 锁住的语义：
 * - ftsSearch 有命中 → systemPromptOverride 拼接 "Starting points from the index" 引导块
 * - ftsSearch 空结果 / 索引无 ftsSearch（stub）→ prompt 与现状逐字一致（降级不注入）
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IndexClient, SymbolSearchResult } from "@owncoder/index";
import { runExploreSubagent } from "./run-subagent.ts";
import type { AgentLoopResult } from "../loop/types.ts";

vi.mock("../loop.ts", () => ({
  runAgentLoop: vi.fn(),
}));
vi.mock("../../git.ts", () => ({
  isGitRepo: vi.fn(async () => false),
}));

import { runAgentLoop } from "../loop.ts";
const mockedRunAgentLoop = vi.mocked(runAgentLoop);

function sym(path: string, name: string, line = 12): SymbolSearchResult {
  return { path, name, kind: "function", line, score: 0.9 };
}

function fakeIndex(results: SymbolSearchResult[] | undefined): IndexClient {
  return {
    ftsSearch: results === undefined ? undefined : vi.fn(async () => results),
  } as unknown as IndexClient;
}

function baseDeps(index: IndexClient) {
  return {
    workspaceRoot: "/tmp/ws",
    sessionId: "sess-nav",
    workflow: {} as never,
    mode: "agent" as const,
    index,
    llmApiKey: "test-key",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedRunAgentLoop.mockResolvedValue({
    assistantText: "## Final Report\n\n结论：登录失败",
  } as AgentLoopResult);
});

describe("runExploreSubagent — Planner 输入可见", () => {
  it.each([
    { assistantText: "## Final Report\n\n计划", partial: false },
    { assistantText: "", partial: true },
  ])("在子代理返回前发送实际输入，失败时仍保留：$partial", async ({ assistantText, partial }) => {
    mockedRunAgentLoop.mockResolvedValueOnce({ assistantText } as AgentLoopResult);
    const onEvent = vi.fn();
    const task = "跨文件计划\n第二行 ghp_abcdefghijklmnopqrstuvwxyz0123456789\n" + "后续信息".repeat(2000);
    const result = await runExploreSubagent({ agentType: "Planner", task }, { ...baseDeps(fakeIndex([])), onEvent });
    const opts = mockedRunAgentLoop.mock.calls[0]![0];
    const start = onEvent.mock.calls.find(([event]) => event.type === "stage_start")![0];
    expect(start.subagentInput.userMessage).toBe(task.replace(/ghp_[A-Za-z0-9]{36}/, "***"));
    expect(start.subagentInput.systemPromptOverride).toBe(opts.systemPromptOverride);
    expect(start.subagentInput.thoroughness).toBe("medium");
    expect(opts.userMessage).toBe(task);
    expect(onEvent.mock.invocationCallOrder[0]).toBeLessThan(mockedRunAgentLoop.mock.invocationCallOrder[0]);
    expect(result.report.startsWith("[Planner partial result")).toBe(partial);
    expect(onEvent.mock.calls.at(-1)![0]).toMatchObject({ type: "stage_done", ok: !partial });
  });
});

describe("runExploreSubagent — 分解历史注入", () => {
  it.each(["Planner", "Explore"])("向 %s 提示词注入背景证据", async (agentType) => {
    await runExploreSubagent(
      { agentType, task: "检查实现", relevantHistory: "src/auth.ts:42 已确认 validateToken 入口" },
      baseDeps(fakeIndex([])),
    );
    const prompt = mockedRunAgentLoop.mock.calls[0]![0].systemPromptOverride as string;
    expect(prompt).toContain("任务分解阶段相关历史");
    expect(prompt).toContain("src/auth.ts:42 已确认 validateToken 入口");
    expect(prompt).toContain("不是当前指令");
  });

  it.each([undefined, "", "   "])("空历史不产生占位段落：%s", async (relevantHistory) => {
    await runExploreSubagent(
      { agentType: "Explore", task: "检查实现", relevantHistory },
      baseDeps(fakeIndex([])),
    );
    const prompt = mockedRunAgentLoop.mock.calls[0]![0].systemPromptOverride as string;
    expect(prompt).not.toContain("任务分解阶段相关历史");
  });
});

describe("runExploreSubagent — Planner 循环配置", () => {
  it("Planner：plannerLoop 标志 + submit_plan 白名单 + 小预算（25）", async () => {
    await runExploreSubagent({ agentType: "Planner", task: "制定跨文件改动计划" }, baseDeps(fakeIndex([])));
    const opts = mockedRunAgentLoop.mock.calls[0]![0];
    expect(opts.plannerLoop).toBe(true);
    expect(opts.exploreLoop).toBeUndefined();
    expect(opts.allowedTools).toContain("submit_plan");
    expect(opts.allowedTools).not.toContain("submit_report");
    expect(opts.maxIterations).toBe(25);
    expect(opts.forcedFinalReportOnLimit).toBe(true);
  });

  it("Explore：exploreLoop 标志 + submit_report 白名单，预算仍按广度分级（medium=40）", async () => {
    await runExploreSubagent({ agentType: "Explore", task: "调研入口" }, baseDeps(fakeIndex([])));
    const opts = mockedRunAgentLoop.mock.calls[0]![0];
    expect(opts.exploreLoop).toBe(true);
    expect(opts.plannerLoop).toBeUndefined();
    expect(opts.allowedTools).toContain("submit_report");
    expect(opts.allowedTools).not.toContain("submit_plan");
    expect(opts.maxIterations).toBe(40);
    expect(opts.forcedFinalReportOnLimit).toBe(true);
  });
});

describe("runExploreSubagent — 假成功修复（aborted 终态）", () => {
  it("工具循环检测中止（aborted 且无 blocked）：标 partial 而非完整报告", async () => {
    // 历史 bug：detectToolLoop 终止只带 aborted 不带 blocked，过渡文本被
    // 当成完整 ## Final Report 交付且无任何未完成标注。
    mockedRunAgentLoop.mockResolvedValueOnce({
      assistantText: "现在读取下一个文件…",
      aborted: true,
    } as AgentLoopResult);
    const result = await runExploreSubagent({ agentType: "Explore", task: "调研入口" }, baseDeps(fakeIndex([])));
    expect(result.report).toMatch(/^\[Explore partial result: loop terminated early;/);
    expect(result.report).toContain("现在读取下一个文件");
  });

  it("Planner 同样：aborted 终态不再被当作完整计划", async () => {
    mockedRunAgentLoop.mockResolvedValueOnce({
      assistantText: "## Final Report\n### 目标\n未完成",
      aborted: true,
    } as AgentLoopResult);
    const onEvent = vi.fn();
    const result = await runExploreSubagent({ agentType: "Planner", task: "制定计划" }, { ...baseDeps(fakeIndex([])), onEvent });
    expect(result.report).toMatch(/^\[Planner partial result: loop terminated early;/);
    expect(onEvent.mock.calls.at(-1)![0]).toMatchObject({ type: "stage_done", ok: false });
  });
});

describe("runExploreSubagent — Planner 部分结果", () => {
  it.each([
    { assistantText: "", blocked: false, marker: "without producing a report" },
    { assistantText: "## Final Report\n### 目标\n未完成", blocked: true, marker: "reached the iteration limit" },
  ])("不会把未完成的报告伪装为完整计划：$marker", async ({ assistantText, blocked, marker }) => {
    mockedRunAgentLoop.mockResolvedValueOnce({ assistantText, blocked, blockedReason: blocked ? marker : undefined } as AgentLoopResult);
    const result = await runExploreSubagent({ agentType: "Planner", task: "计划跨文件改动" }, baseDeps(fakeIndex([])));
    expect(result.report).toMatch(/^\[Planner partial result:/);
    expect(result.report).toContain(marker);
    expect(mockedRunAgentLoop.mock.calls[0]![0].allowedTools).not.toContain("dispatch_agent");
  });
});

describe("runExploreSubagent — 索引导航引导块", () => {
  it("ftsSearch 有命中 → systemPromptOverride 含引导块与命中符号", async () => {
    const index = fakeIndex([sym("src/auth.ts", "validateToken", 42), sym("src/auth.ts", "login", 88)]);
    await runExploreSubagent(
      { agentType: "Explore", task: "为什么 UserService 的 validateToken 登录失败", thoroughness: "medium" },
      baseDeps(index),
    );
    const prompt = mockedRunAgentLoop.mock.calls[0]![0].systemPromptOverride as string;
    expect(prompt).toContain("Starting points from the index");
    expect(prompt).toContain("validateToken");
    expect(prompt).toContain("src/auth.ts:42");
    // 引导块位于 Explore 纪律 prompt 之后（拼接，不替换）
    expect(prompt.indexOf("You are OwnCoder Explore")).toBeLessThan(prompt.indexOf("Starting points from the index"));
  });

  it("ftsSearch 空结果 → 不注入引导块（降级为现状）", async () => {
    const index = fakeIndex([]);
    await runExploreSubagent(
      { agentType: "Explore", task: "排查 validateToken", thoroughness: "medium" },
      baseDeps(index),
    );
    const prompt = mockedRunAgentLoop.mock.calls[0]![0].systemPromptOverride as string;
    expect(prompt).not.toContain("Starting points from the index");
    // 基础 Explore prompt 不受影响
    expect(prompt).toContain("You are OwnCoder Explore");
  });

  it("索引无 ftsSearch（stub 索引）→ 同样降级", async () => {
    await runExploreSubagent(
      { agentType: "Explore", task: "排查 validateToken", thoroughness: "medium" },
      baseDeps({} as IndexClient),
    );
    const prompt = mockedRunAgentLoop.mock.calls[0]![0].systemPromptOverride as string;
    expect(prompt).not.toContain("Starting points from the index");
  });

  it("ftsSearch 抛错 → 降级不注入，子代理仍正常运行", async () => {
    const index = { ftsSearch: vi.fn(async () => { throw new Error("index corrupt"); }) } as unknown as IndexClient;
    const run = await runExploreSubagent(
      { agentType: "Explore", task: "排查 validateToken", thoroughness: "medium" },
      baseDeps(index),
    );
    expect(typeof run.report).toBe("string");
    const prompt = mockedRunAgentLoop.mock.calls[0]![0].systemPromptOverride as string;
    expect(prompt).not.toContain("Starting points from the index");
  });
});
