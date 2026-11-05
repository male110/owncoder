import { beforeEach, describe, expect, it, vi } from "vitest";
import { chatCompletionStream, type ChatMessage } from "@owncoder/llm";
import {
  DEFAULT_VERIFY_PROMPT,
  mergeVerificationIntoAssistant,
  runVerifyReport,
} from "./react-verify.ts";
import type { AgentLoopOpts, ChatTurn } from "./types.ts";

vi.mock("@owncoder/llm", async (importOriginal) => ({
  ...await importOriginal<typeof import("@owncoder/llm")>(),
  assertLlmAuth: vi.fn(),
  chatCompletionStream: vi.fn(),
}));
vi.mock("./stages.ts", () => ({ resolveStageModel: vi.fn(() => ({ model: "verify-model" })) }));

function makeOpts(): AgentLoopOpts {
  return {
    mode: "agent",
    sessionId: "verify-test",
    signal: undefined,
    llmApiKey: "test-key",
    onEvent: vi.fn(),
  } as unknown as AgentLoopOpts;
}

function mockResponse(content: string) {
  vi.mocked(chatCompletionStream).mockResolvedValueOnce({
    choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  } as Awaited<ReturnType<typeof chatCompletionStream>>);
}

describe("runVerifyReport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("默认提示词要求 Markdown 结构报告", () => {
    expect(DEFAULT_VERIFY_PROMPT).toMatch(/Markdown/);
    expect(DEFAULT_VERIFY_PROMPT).toContain("## Verdict");
    expect(DEFAULT_VERIFY_PROMPT).toContain("## Evidence");
    expect(DEFAULT_VERIFY_PROMPT).toContain("## Gaps");
  });

  it("默认节点返回 Markdown 报告并原样透传", async () => {
    const report = [
      "## Verdict",
      "**Verified**",
      "## Evidence",
      "- `src/a.ts` 已修改并通过测试",
      "## Gaps",
      "None",
    ].join("\n");
    mockResponse(report);
    const node = { id: "verify", type: "verify", prompt: "" } as never;
    const out = await runVerifyReport(makeOpts(), node, [], "工作已完成");
    expect(out).toBe(report);
    const call = vi.mocked(chatCompletionStream).mock.calls[0]!;
    const messages = call[1] as ChatMessage[];
    expect(messages.at(-2)?.content).toContain("## Verify stage");
    expect(messages.at(-2)?.content).toContain("## Verdict");
  });

  it("自定义 prompt 输出非 Markdown 纯文本时保持容忍、原样返回", async () => {
    mockResponse("Verified. Everything looks good.");
    const node = { id: "verify", type: "verify", prompt: "Give a one-line verdict." } as never;
    const out = await runVerifyReport(makeOpts(), node, [], "done");
    expect(out).toBe("Verified. Everything looks good.");
  });

  it("空回答返回空字符串而不抛错", async () => {
    mockResponse("");
    const node = { id: "verify", type: "verify", prompt: "" } as never;
    const out = await runVerifyReport(makeOpts(), node, [], "done");
    expect(out).toBe("");
  });
});

describe("mergeVerificationIntoAssistant", () => {
  it("Markdown 报告合并进 ### Verification 段落并写回最后一条 assistant 历史", () => {
    const history: ChatTurn[] = [
      { role: "user", content: "q" },
      { role: "assistant", content: "完成" },
    ];
    const combined = mergeVerificationIntoAssistant("完成", "## Verdict\n**Verified**", history);
    expect(combined).toBe("完成\n\n---\n### Verification\n## Verdict\n**Verified**");
    expect(history.at(-1)?.content).toBe(combined);
  });

  it("非 Markdown 纯文本同样兼容合并", () => {
    const history: ChatTurn[] = [{ role: "assistant", content: "完成" }];
    const combined = mergeVerificationIntoAssistant("完成", "Verified, looks fine.", history);
    expect(combined).toContain("### Verification\nVerified, looks fine.");
  });

  it("空校验文本不追加段落", () => {
    const history: ChatTurn[] = [{ role: "assistant", content: "完成" }];
    const combined = mergeVerificationIntoAssistant("完成", "   ", history);
    expect(combined).toBe("完成");
    expect(history.at(-1)?.content).toBe("完成");
  });

  it("末尾不是 assistant 时追加新 assistant 历史条目", () => {
    const history: ChatTurn[] = [{ role: "user", content: "q" }];
    const combined = mergeVerificationIntoAssistant("报告", "## Verdict\n**Not verified**", history);
    expect(history).toHaveLength(2);
    expect(history.at(-1)).toEqual({ role: "assistant", content: combined });
  });
});
