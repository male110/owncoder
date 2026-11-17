import { beforeEach, describe, expect, it, vi } from "vitest";
import { executeTool } from "../execute.ts";
import { createLoopState } from "./termination.ts";
import { executeIterationTools } from "./react-tool-exec.ts";
import type { ReActLoopContext } from "./react-loop-context.ts";
import type { TurnEvent } from "./types.ts";

vi.mock("../execute.ts", () => ({ executeTool: vi.fn() }));

const file = "src/plans.ts";

function makeContext() {
  const events: TurnEvent[] = [];
  const ctx = {
    opts: { mode: "agent", userMessage: "Read the file", sessionId: "read-test", onEvent: (event: TurnEvent) => events.push(event) },
    toolCtx: { workspaceRoot: process.cwd() },
    messages: [],
    history: [],
    decisionSummaries: [],
    memory: { addToolOutput: vi.fn() },
    tracer: { startSpan: vi.fn(() => "span"), endSpan: vi.fn() },
    reasoningTrace: { steps: [] },
    currentTask: null,
    turnInformationTask: null,
    currentStep: null,
    taskRunState: null,
    loopState: createLoopState(undefined),
    maxSameFileReads: 0,
    maxConsecutiveReadonlyIters: 0,
    sameFileReads: new Map<string, number>(),
    loopNudgeEnabled: false,
    toolExecParallel: false,
    gitSnapshotEnabled: false,
    docDeliverableEnabled: false,
    documentDelivered: false,
    handoffRequested: false,
    totalToolCalls: 0,
    consecutiveReadonlyIters: 0,
  } as unknown as ReActLoopContext;
  return { ctx, events };
}

async function call(ctx: ReActLoopContext, name: string, args: Record<string, unknown>, iteration: number) {
  return executeIterationTools(
    ctx, iteration, [{ id: `call-${iteration}`, name, arguments: args, rawArguments: JSON.stringify(args) }], "", "tool_calls",
    { promptTokens: 0, completionTokens: 0, totalTokens: 0, source: "provider" },
  );
}

function mockRead(offset: number) {
  vi.mocked(executeTool).mockResolvedValueOnce({
    ok: true,
    output: `lines ${offset}-${offset + 4}`,
    metadata: { kind: "read_file", path: file, startLine: offset, endLine: offset + 4, totalLines: 900, hasMore: true, nextOffset: offset + 5 },
  } as Awaited<ReturnType<typeof executeTool>>);
}

function nudges(ctx: ReActLoopContext) {
  return ctx.messages.filter((message) => message.role === "system" && String(message.content).includes("Unread lines"));
}

describe("同文件小范围读取软守卫", () => {
  beforeEach(() => vi.clearAllMocks());

  it("第 4 次成功读取后仅提示一次，不跳过工具调用", async () => {
    const { ctx, events } = makeContext();
    for (let i = 0; i < 5; i++) {
      const offset = 712 + i * 5;
      mockRead(offset);
      await call(ctx, "read_file", { file_path: file, offset, limit: 5 }, i);
      expect(nudges(ctx)).toHaveLength(i < 3 ? 0 : 1);
    }
    expect(nudges(ctx)[0]?.content).toContain(file);
    expect(nudges(ctx)[0]?.content).toContain("732-900");
    expect(nudges(ctx)[0]?.content).toContain("limit=169");
    expect(events.filter((event) => event.type === "tool_end")).toHaveLength(5);
    expect(events.some((event) => event.type === "tool_end" && event.skipped)).toBe(false);
    expect(executeTool).toHaveBeenCalledTimes(5);
  });

  it("文件写入或任务切换清零后允许重新累计提示", async () => {
    const { ctx, events } = makeContext();
    let iteration = 0;
    async function fourReads() {
      for (let i = 0; i < 4; i++) {
        const offset = 712 + i * 5;
        mockRead(offset);
        await call(ctx, "read_file", { file_path: file, offset, limit: 5 }, iteration++);
      }
    }
    await fourReads();
    expect(nudges(ctx)).toHaveLength(1);
    vi.mocked(executeTool).mockResolvedValueOnce({ ok: true, output: "edited", metadata: { kind: "file_mutation", paths: [file] } } as Awaited<ReturnType<typeof executeTool>>);
    await call(ctx, "write_file", { file_path: file, content: "edited" }, iteration++);
    expect(ctx.sameFileReads.size).toBe(0);
    await fourReads();
    expect(nudges(ctx)).toHaveLength(2);
    ctx.sameFileReads.clear();
    await fourReads();
    expect(nudges(ctx)).toHaveLength(3);
    expect(events.some((event) => event.type === "tool_end" && event.skipped)).toBe(false);
  });
});

describe("ReAct 执行阶段禁止派发 Planner 子代理", () => {
  beforeEach(() => vi.clearAllMocks());

  it('dispatch_agent agent_type="Planner" 被硬拒：不触达 executeTool，返回工具级错误且不断裂循环', async () => {
    const { ctx, events } = makeContext();
    await call(ctx, "dispatch_agent", { agent_type: "Planner", task: "生成执行计划" }, 0);
    expect(executeTool).not.toHaveBeenCalled();
    expect(events.some((event) => event.type === "tool_end" && event.ok === false && String(event.output).includes("任务分解"))).toBe(true);
  });

  it('dispatch_agent agent_type="Explore" 不受影响，正常派发', async () => {
    const { ctx, events } = makeContext();
    vi.mocked(executeTool).mockResolvedValueOnce({
      ok: true,
      output: "## Final Report\n结论",
    } as Awaited<ReturnType<typeof executeTool>>);
    await call(ctx, "dispatch_agent", { agent_type: "Explore", task: "调研入口" }, 0);
    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(events.some((event) => event.type === "tool_end" && event.ok === true)).toBe(true);
  });
});
