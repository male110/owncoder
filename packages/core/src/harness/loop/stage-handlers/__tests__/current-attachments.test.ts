import { beforeEach, describe, expect, it, vi } from "vitest";
import { chatCompletion } from "@owncoder/llm";
import { BUILTIN_WORKFLOW } from "@owncoder/settings";
import { contextBudgets } from "../../../budget.ts";
import { injectHistoryAndUserMessage } from "../index.ts";
import { runTaskDecompose } from "../task-decompose.ts";
import type { SchedulerContext } from "../types.ts";
import type { ChatAttachment } from "@owncoder/llm";

vi.mock("@owncoder/llm", async (importOriginal) => ({
  ...await importOriginal<typeof import("@owncoder/llm")>(),
  assertLlmAuth: vi.fn(),
  chatCompletion: vi.fn(),
  writeEventLog: vi.fn(),
}));

const expiredAttachment: ChatAttachment = {
  name: "old.png", mimeType: "image/png", url: "https://example.invalid/expired.png",
};
const currentAttachment: ChatAttachment = {
  name: "new.png", mimeType: "image/png", url: "https://example.invalid/current.png",
};

function makeContext(attachments: ChatAttachment[], withHistory: boolean, packedHistory: boolean): SchedulerContext {
  const history = withHistory ? [
    { role: "user" as const, content: "上一轮的问题", attachments: [expiredAttachment] },
    { role: "assistant" as const, content: "上一轮的结论" },
  ] : [];
  return {
    opts: {
      mode: "agent", workspaceRoot: process.cwd(), workflow: BUILTIN_WORKFLOW,
      userMessage: "继续处理", history, attachments,
    },
    history: [...history], messages: [],
    state: {
      userMessageInjected: false,
      turnInformationTask: packedHistory ? { relevantHistory: "上一轮的结论" } : null,
    },
    model: { model: "test-model" },
    budgets: contextBudgets(BUILTIN_WORKFLOW),
    tracer: { startSpan: vi.fn(), endSpan: vi.fn(), recordTokenUsage: vi.fn() },
    memory: { setActivePlan: vi.fn() },
    reasoningTrace: { steps: [] },
  } as unknown as SchedulerContext;
}

describe("附件仅随上传所在轮次发送", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(chatCompletion).mockResolvedValue({
      choices: [{ message: { role: "assistant", content: JSON.stringify({
        intent: "继续处理", tasks: [{ id: "task_1", description: "处理问题", steps: [
          { id: "step_1", description: "检查代码", dependsOn: [] },
        ] }],
      }) } }],
    } as Awaited<ReturnType<typeof chatCompletion>>);
  });

  it.each([
    { name: "首次上传", attachments: [currentAttachment], withHistory: false },
    { name: "带过期附件的历史续聊", attachments: [], withHistory: true },
    { name: "历史续聊时上传新附件", attachments: [currentAttachment], withHistory: true },
    { name: "普通无附件对话", attachments: [], withHistory: false },
  ])("$name：分解和执行均只发送本轮附件", async ({ attachments, withHistory }) => {
    const ctx = makeContext(attachments, withHistory, false);
    const result = await runTaskDecompose(
      ctx.opts, ctx.model, ctx.tracer, ctx.memory, ctx.reasoningTrace, ctx.budgets,
    );
    expect(result.fallback).toBe(false);
    const sent = vi.mocked(chatCompletion).mock.calls[0][1];
    const user = sent.find((message) => message.role === "user")!;
    expect(user.attachments).toEqual(attachments);
    expect(user.content).not.toContain(expiredAttachment.url);
    if (withHistory) {
      expect(user.content).toContain("上一轮的问题");
      expect(user.content).toContain("上一轮的结论");
    }
    await injectHistoryAndUserMessage(ctx);
    expect(ctx.messages.at(-1)?.attachments).toEqual(attachments);
    expect(ctx.history.at(-1)?.attachments ?? []).toEqual(attachments);
    if (withHistory) expect(ctx.history[0].attachments).toEqual([expiredAttachment]);
  });

  it("有分解历史时也不重新附带历史附件", async () => {
    const ctx = makeContext([], true, true);
    await injectHistoryAndUserMessage(ctx);
    expect(ctx.messages.at(-1)?.attachments).toEqual([]);
    expect(ctx.messages.at(-1)?.content).toContain("上一轮的结论");
    expect(ctx.history.at(-1)?.attachments).toBeUndefined();
  });
});
