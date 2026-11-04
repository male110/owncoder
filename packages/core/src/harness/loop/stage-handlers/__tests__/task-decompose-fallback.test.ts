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
import { runTaskDecompose } from "../task-decompose.ts";
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
