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
    const report = await runExploreSubagent(
      { agentType: "Explore", task: "排查 validateToken", thoroughness: "medium" },
      baseDeps(index),
    );
    expect(typeof report).toBe("string");
    const prompt = mockedRunAgentLoop.mock.calls[0]![0].systemPromptOverride as string;
    expect(prompt).not.toContain("Starting points from the index");
  });
});
