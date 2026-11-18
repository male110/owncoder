import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chatCompletionStream, type ToolCall } from "@owncoder/llm";
import { BUILTIN_WORKFLOW } from "@owncoder/settings";
import { approvePlannerPlan, readPlannerPlan, savePlannerPlan } from "../../plans.ts";
import type { VerificationResult } from "../../task-run.ts";
import { runAgentLoop } from "../loop.ts";
import { SPEC_TASK_OUTCOME_TOOL, SPEC_TASK_REPORT_REQUIRED } from "./single-spec-task.ts";
import type { AgentLoopOpts } from "./types.ts";

const { verify, dispatch, snapshot } = vi.hoisted(() => ({ verify: vi.fn(), dispatch: vi.fn(), snapshot: vi.fn() }));
vi.mock("@owncoder/llm", async (original) => ({
  ...await original<typeof import("@owncoder/llm")>(), chatCompletionStream: vi.fn(), writeEventLog: vi.fn(),
}));
vi.mock("../checkpoint.ts", async (original) => ({
  ...await original<typeof import("../checkpoint.ts")>(), gitAutoSnapshot: snapshot,
}));
vi.mock("../execute.ts", async (original) => ({
  ...await original<typeof import("../execute.ts")>(), executeTool: dispatch,
}));
vi.mock("../verification.ts", async (original) => ({
  ...await original<typeof import("../verification.ts")>(), VerificationEngine: class { verify = verify; },
}));
vi.mock("../../turn-rounds.ts", async (original) => ({
  ...await original<typeof import("../../turn-rounds.ts")>(), persistRoundReport: vi.fn(async () => null),
  persistRoundToolCalls: vi.fn(async () => undefined),
}));

const model = vi.mocked(chatCompletionStream);
const tool = (name: string, args: object): ToolCall => ({
  id: name, type: "function", function: { name, arguments: JSON.stringify(args) },
});
function respond(content = "", calls?: ToolCall[]) {
  return {
    choices: [{ message: { role: "assistant", content, tool_calls: calls }, finish_reason: calls ? "tool_calls" : "stop" }],
  } as Awaited<ReturnType<typeof chatCompletionStream>>;
}
const submission = (status: "completed" | "failed" = "completed", result = "No errors found.") =>
  tool(SPEC_TASK_OUTCOME_TOOL, { status, result });

describe("single Spec task execution", () => {
  let root: string;
  const options = (extra: Partial<AgentLoopOpts> = {}): AgentLoopOpts => ({
    mode: "agent", sessionId: "spec-task", workspaceRoot: root, history: [], workflow: BUILTIN_WORKFLOW,
    index: { status: () => ({ kind: "disabled" }) } as unknown as AgentLoopOpts["index"],
    llmApiKey: "test-key", userMessage: "continue", maxIterations: 1, enableAutoFix: false,
    singleSpecTask: true, currentTaskId: "selected", taskRunState: null,
    activeTasks: [{ id: "selected", executionGuidance: "Perform only this verifiable task", status: "pending",
      dependsOn: ["already-resolved-by-caller"], retryCount: 0, maxRetries: 1 }],
    persistExperiencesOverride: async () => [],
    onTaskUpdate: vi.fn(), onEvent: vi.fn(), ...extra,
  });

  beforeEach(async () => {
    vi.resetAllMocks();
    root = await fs.mkdtemp(join(tmpdir(), "owncoder-single-spec-task-"));
    snapshot.mockResolvedValue({ ok: false, reason: "not_repo" });
    dispatch.mockResolvedValue({ ok: true, output: "OK" });
  });
  afterEach(async () => fs.rm(root, { recursive: true, force: true }));

  it("runs only the selected task, exposes only the scoped outcome, and leaves terminal persistence to the caller", async () => {
    model.mockResolvedValueOnce(respond("", [submission(), tool("write_file", { path: "unexpected" })]));
    const opts = options();
    const result = await runAgentLoop(opts);
    expect(result.specTaskOutcome).toEqual({ status: "completed", result: "No errors found." });
    expect(result.taskRunState?.phase).toBe("completed");
    expect(opts.onTaskUpdate).toHaveBeenCalledExactlyOnceWith([expect.objectContaining({ id: "selected", status: "in_progress" })], "selected");
    expect(opts.activeTasks?.[0]?.status).toBe("pending");
    expect(model).toHaveBeenCalledTimes(1);
    expect(dispatch).not.toHaveBeenCalled();
    const [, messages, callOptions] = model.mock.calls[0]!;
    expect(messages.some((message) => message.content?.includes("only the selected Spec task"))).toBe(true);
    expect(messages.at(-1)?.content).toContain(SPEC_TASK_OUTCOME_TOOL);
    const names = callOptions?.tools?.map((t) => t.function.name);
    expect(names).toEqual(expect.arrayContaining([SPEC_TASK_OUTCOME_TOOL, "report_blocker", "write_file"]));
    for (const name of ["add_tasks", "update_tasks", "save_tasks", "save_spec", "save_design", "submit_plan"]) {
      expect(names).not.toContain(name);
    }
  });

  it.each(["All changes are complete.", 'submit_task_outcome({"status":"completed","result":"done"})'])("fails safely without a native report: %s", async (text) => {
    model.mockResolvedValueOnce(respond(text));
    expect((await runAgentLoop(options())).specTaskOutcome).toEqual({ status: "failed", result: SPEC_TASK_REPORT_REQUIRED });
  });

  it("never accepts an invalid report even when the model exhausts its budget", async () => {
    model.mockResolvedValueOnce(respond("", [tool(SPEC_TASK_OUTCOME_TOOL, { status: "completed", result: " " })]));
    expect((await runAgentLoop(options())).specTaskOutcome?.status).toBe("failed");
  });

  it("uses structured failure and blocker independently of prose", async () => {
    model.mockResolvedValueOnce(respond("", [submission("failed", "Finished the attempt.")]));
    expect((await runAgentLoop(options())).specTaskOutcome).toEqual({ status: "failed", result: "Finished the attempt." });
    model.mockResolvedValueOnce(respond("", [tool("report_blocker", { reason: "needs_user_decision", summary: "Missing credentials", userAction: "Choose a provider" })]));
    expect((await runAgentLoop(options())).specTaskOutcome).toEqual({ status: "blocked", result: expect.stringContaining("Missing credentials") });
  });

  it.each([true, false])("honors final post_verify after a same-batch edit and submission (pass=%s)", async (passed) => {
    model.mockResolvedValueOnce(respond("", [tool("write_file", { path: "src/a.ts" }), submission()]));
    dispatch.mockImplementationOnce(async (ctx: { touchedPaths?: string[] }) => {
      ctx.touchedPaths?.push("src/a.ts");
      return { ok: true, output: "Wrote src/a.ts" };
    });
    verify.mockResolvedValueOnce({
      status: passed ? "passed" : "failed", passed,
      summary: passed ? "Verified" : "Typecheck rejected this change", suggestions: [],
      checks: [{ name: "typecheck", type: "typecheck", status: passed ? "passed" : "failed", passed, duration: 1, output: "", errors: [] }],
    } satisfies VerificationResult);
    const result = await runAgentLoop(options());
    expect(verify).toHaveBeenCalledExactlyOnceWith(["src/a.ts"]);
    expect(result.specTaskOutcome?.status).toBe(passed ? "completed" : "failed");
    expect(result.successRejected).toBe(!passed);
  });
  it("cannot complete a changed task without a verification result", async () => {
    model.mockResolvedValueOnce(respond("", [tool("write_file", { path: "src/a.ts" }), submission()]));
    dispatch.mockImplementationOnce(async (ctx: { touchedPaths?: string[] }) => {
      ctx.touchedPaths?.push("src/a.ts");
      return { ok: true, output: "Wrote src/a.ts" };
    });
    const result = await runAgentLoop(options({ enableVerification: false }));
    expect(verify).not.toHaveBeenCalled();
    expect(result.specTaskOutcome?.status).toBe("failed");
    expect(result.successRejected).toBe(true);
  });


  it("does not activate a different task or bypass a pending Agent Planner approval", async () => {
    const invalid = options({ currentTaskId: "different" });
    expect((await runAgentLoop(invalid)).specTaskOutcome?.status).toBe("failed");
    expect(invalid.onTaskUpdate).not.toHaveBeenCalled();
    const opts = options();
    await savePlannerPlan(root, opts.sessionId, "agent", "# Unrelated Agent plan\n\nImplement a different task.");
    expect((await runAgentLoop(opts)).specTaskOutcome?.status).toBe("blocked");
    expect((await readPlannerPlan(root, opts.sessionId))?.status).toBe("pending_approval");
    expect(opts.onTaskUpdate).not.toHaveBeenCalled();
    expect(model).not.toHaveBeenCalled();
  });

  it("does not resume or substitute an already approved Agent Planner plan", async () => {
    const opts = options({ userMessage: "approve" });
    const plan = await savePlannerPlan(root, opts.sessionId, "agent", "# Unrelated Agent plan\n\nImplement a different task.");
    await approvePlannerPlan(root, opts.sessionId, plan);
    model.mockResolvedValueOnce(respond("", [submission()]));
    expect((await runAgentLoop(opts)).specTaskOutcome?.status).toBe("completed");
    expect(model.mock.calls[0]?.[1].some((message) => message.content?.includes("Unrelated Agent plan"))).toBe(false);
  });

  it("returns cancelled for an aborted run without starting the task", async () => {
    const opts = options({ signal: AbortSignal.abort() });
    expect((await runAgentLoop(opts)).specTaskOutcome).toEqual({ status: "cancelled" });
    expect(opts.onTaskUpdate).not.toHaveBeenCalled();
    expect(model).not.toHaveBeenCalled();
  });
});
