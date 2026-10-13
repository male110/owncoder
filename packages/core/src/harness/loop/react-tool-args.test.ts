import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultReactSteps } from "@owncoder/settings";
import { chatCompletionStream } from "@owncoder/llm";
import { executeTool } from "../execute.ts";
import { runReActLoop } from "./react.ts";
import type { ChatTurn, ReActLoopArgs, TurnEvent } from "./types.ts";
import { MessageProjector } from "../../message-projector.ts";

vi.mock("@owncoder/llm", async (importOriginal) => ({
  ...await importOriginal<typeof import("@owncoder/llm")>(),
  chatCompletionStream: vi.fn(),
  writeEventLog: vi.fn(),
}));
vi.mock("../execute.ts", () => ({ executeTool: vi.fn() }));

type Call = { id: string; name: string; arguments: Record<string, unknown> };

async function runCalls(calls: Call[], extra: Partial<ReActLoopArgs> = {}) {
  const history: ChatTurn[] = [{ role: "user", content: "检查工具参数" }];
  const events: TurnEvent[] = [];
  vi.mocked(chatCompletionStream).mockResolvedValueOnce({
    choices: [{
      message: {
        role: "assistant",
        content: "",
        tool_calls: calls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: JSON.stringify(call.arguments) },
        })),
      },
      finish_reason: "tool_calls",
    }],
  } as Awaited<ReturnType<typeof chatCompletionStream>>);
  const args = {
    opts: { mode: "plan", sessionId: "args-test", userMessage: "检查工具参数", onEvent: (ev: TurnEvent) => events.push(ev) },
    model: { model: "test-model" },
    messages: [{ role: "user", content: "检查工具参数" }],
    history,
    toolsFinal: calls.filter((call) => call.name !== "unknown_tool").map((call) => ({
      type: "function", function: { name: call.name, parameters: { type: "object", properties: {} } },
    })),
    toolCtx: { workspaceRoot: process.cwd() },
    maxIter: 1,
    stageId: "react",
    reasoningTrace: { steps: [] },
    memory: { addToolOutput: vi.fn() },
    tracer: { startSpan: vi.fn(), endSpan: vi.fn(), recordTokenUsage: vi.fn(), addEvent: vi.fn(), recordError: vi.fn() },
    plan: null,
    correctionCount: 0,
    reactSteps: defaultReactSteps().map((step) => ({ ...step, enabled: !["git_snapshot", "auto_fix"].includes(step.id) })),
    ...extra,
  } as ReActLoopArgs;
  await runReActLoop(args);
  return { history, events };
}

describe("ReAct 工具历史参数", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(executeTool).mockResolvedValue({ ok: true, output: "完成" });
  });

  it.each([true, false])("工具成功或失败后保留参数，且与事件投影一致：ok=%s", async (ok) => {
    vi.mocked(executeTool).mockResolvedValue({ ok, output: ok ? "完成" : "Error: failed" });
    const calls: Call[] = [
      { id: "outline", name: "read_outline", arguments: { file_path: "src/index.ts" } },
      { id: "read", name: "read_file", arguments: { file_path: "src/index.ts", offset: 12, limit: 8 } },
      { id: "status", name: "git_status", arguments: {} },
    ];
    const { history, events } = await runCalls(calls);
    const tools = history.filter((turn) => turn.role === "tool");
    expect(tools.map((turn) => ({ id: turn.id, toolArgs: turn.toolArgs }))).toEqual(
      calls.map((call) => ({ id: call.id, toolArgs: call.arguments })),
    );
    const projector = new MessageProjector();
    for (const event of events) projector.handleEvent(event);
    const projected = MessageProjector.partsToChatTurns(projector.finalize().parts).filter((turn) => turn.role === "tool");
    expect(tools.map((turn) => turn.toolArgs)).toEqual(projected.map((turn) => turn.toolArgs));
  });

  it("交还用户后跳过的工具仍保留同一调用的参数", async () => {
    const calls: Call[] = [
      { id: "blocker", name: "report_blocker", arguments: { reason: "needs_user_decision", summary: "需要选择", userAction: "选择配置" } },
      { id: "skipped", name: "read_outline", arguments: { file_path: "src/skipped.ts" } },
    ];
    const { history, events } = await runCalls(calls);
    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(history.find((turn) => turn.id === "skipped")?.toolArgs).toEqual(calls[1]!.arguments);
    expect(events.some((event) => event.type === "tool_end" && event.id === "skipped" && event.skipped)).toBe(true);
  });

  it("未知工具错误也保留输入参数", async () => {
    const { history } = await runCalls([{ id: "unknown", name: "unknown_tool", arguments: { file_path: "src/file.ts" } }]);
    expect(history.find((turn) => turn.id === "unknown")?.toolArgs).toEqual({ file_path: "src/file.ts" });
  });
});
