import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BUILTIN_WORKFLOW } from "@owncoder/settings";
import { beginTurn, closeConversationStore } from "./conversation-store.ts";
import { runAgentLoop } from "./harness/loop.ts";
import { createSessionRuntime } from "./session-runtime.ts";
import { executeAgentTurn, INTERRUPT_MARKER_SOURCE, INTERRUPT_MARKER_TEXT, type AgentTurnContext } from "./turn-execution.ts";

vi.mock("./harness/loop.ts", () => ({ runAgentLoop: vi.fn() }));

const sid = "abort-session";
let root: string;

beforeEach(async () => {
  vi.resetAllMocks();
  root = await mkdtemp(join(tmpdir(), "owncoder-abort-marker-"));
});
afterEach(async () => {
  closeConversationStore(root, sid);
  await rm(root, { recursive: true, force: true });
});

/** 与 spec-task-turns.test.ts 同款的最小 AgentTurnContext（无 taskRef）。 */
async function runTurn(abort: boolean) {
  const runtime = createSessionRuntime(sid, "agent");
  const turnId = "turn-abort-1";
  const user = { role: "user" as const, content: "写一个长文件", turnId };
  await beginTurn(root, sid, user, turnId);
  runtime.history.push(user);
  const abortController = new AbortController();
  if (abort) abortController.abort();
  vi.mocked(runAgentLoop).mockImplementationOnce(async () => {
    throw new Error("aborted mid-flight");
  });
  const ctx: AgentTurnContext = {
    sessionId: sid,
    text: user.content,
    turnId,
    runtime,
    workspaceRoot: root,
    workflow: BUILTIN_WORKFLOW,
    checkpointEnabled: false,
    attachments: [],
    abortController,
    onEvent: vi.fn(),
    enqueueActivePlanUpdate: <T>(work: () => Promise<T>) => work(),
  } as unknown as AgentTurnContext;
  await expect(executeAgentTurn(ctx)).rejects.toThrow("aborted mid-flight");
  return runtime;
}

describe("用户手动中断的中断标记", () => {
  it("中止时向历史追加合成 user 标记（对 LLM 可见、带 source 与 turnId）", async () => {
    const runtime = await runTurn(true);
    const tail = runtime.history[runtime.history.length - 1]!;
    expect(tail.role).toBe("user");
    expect(tail.content).toBe(INTERRUPT_MARKER_TEXT);
    expect(tail.metadata?.source).toBe(INTERRUPT_MARKER_SOURCE);
    expect(tail.metadata?.aborted).toBe(true);
    // 归属同一轮次：整轮删除时随轮次一起处理。
    expect(tail.turnId).toBe("turn-abort-1");
    // 助理的 [用户已中止] 后缀仍在（界面可见反馈）。
    const assistant = runtime.history[runtime.history.length - 2]!;
    expect(assistant.role).toBe("assistant");
    expect(assistant.content).toContain("[用户已中止]");
  });

  it("非用户中止（普通失败）不产生中断标记", async () => {
    const runtime = await runTurn(false);
    const tail = runtime.history[runtime.history.length - 1]!;
    expect(tail.role).toBe("assistant");
    expect(tail.content).toContain("[执行失败:");
    expect(runtime.history.some((turn) => turn.metadata?.source === INTERRUPT_MARKER_SOURCE)).toBe(false);
  });
});
