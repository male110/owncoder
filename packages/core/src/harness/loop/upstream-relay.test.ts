import { afterEach, describe, expect, it, vi } from "vitest";
import { chatCompletionStream } from "@owncoder/llm";
import { buildUpstreamRelay } from "./upstream-relay.ts";
import type { TaskReport } from "./task-reports.ts";
import type { ReActLoopContext } from "./react-loop-context.ts";

vi.mock("@owncoder/llm", async (importOriginal) => ({
  ...await importOriginal<typeof import("@owncoder/llm")>(),
  chatCompletionStream: vi.fn(),
}));

function makeCtx(reports: TaskReport[]): ReActLoopContext {
  return {
    model: { model: "test-model" },
    stageId: "react",
    opts: { sessionId: "relay-test" },
    taskReports: reports,
  } as unknown as ReActLoopContext;
}

function report(taskId: string, text: string, status: TaskReport["status"] = "completed"): TaskReport {
  return { taskId, executionGuidance: "guidance", status, report: text };
}

const longReport = (id: string) => report(id, `Task ${id} done. `.repeat(120));

describe("buildUpstreamRelay", () => {
  afterEach(() => {
    vi.mocked(chatCompletionStream).mockReset();
  });

  it("returns null when the task has no terminal upstream reports", async () => {
    const ctx = makeCtx([report("t1", "done")]);
    expect(await buildUpstreamRelay(ctx, { id: "t2", executionGuidance: "g", dependsOn: ["t9"] } as never)).toBeNull();
    expect(chatCompletionStream).not.toHaveBeenCalled();
  });

  it("joins short reports directly without an LLM call", async () => {
    const ctx = makeCtx([report("t1", "short report one"), report("t2", "short report two")]);
    const relay = await buildUpstreamRelay(ctx, {
      id: "t3",
      executionGuidance: "g",
      dependsOn: ["t1", "t2"],
    } as never);
    expect(chatCompletionStream).not.toHaveBeenCalled();
    expect(relay).toContain("Upstream task t1");
    expect(relay).toContain("short report two");
  });

  it("uses the LLM summary when upstream reports are long", async () => {
    vi.mocked(chatCompletionStream).mockResolvedValue({
      choices: [{ message: { role: "assistant", content: "**Verified anchors**: src/a.ts L10-40\n**Changed files**: src/a.ts" } }],
    } as never);
    const ctx = makeCtx([longReport("t1"), longReport("t2")]);
    const relay = await buildUpstreamRelay(ctx, {
      id: "t3",
      executionGuidance: "g",
      dependsOn: ["t1", "t2"],
    } as never);
    expect(chatCompletionStream).toHaveBeenCalledTimes(1);
    expect(relay).toContain("Verified anchors");
    // relay system prompt demands extraction-only
    const [, messages] = vi.mocked(chatCompletionStream).mock.calls[0]!;
    expect((messages as { content: string }[])[0]!.content).toContain("Premise conflicts");
  });

  it("falls back to rule-based output when the LLM call fails", async () => {
    vi.mocked(chatCompletionStream).mockRejectedValue(new Error("timeout"));
    const ctx = makeCtx([longReport("t1")]);
    const relay = await buildUpstreamRelay(ctx, {
      id: "t3",
      executionGuidance: "g",
      dependsOn: ["t1"],
    } as never);
    expect(relay).toContain("Upstream task t1");
  });

  it("falls back when the LLM returns empty content", async () => {
    vi.mocked(chatCompletionStream).mockResolvedValue({
      choices: [{ message: { role: "assistant", content: "  " } }],
    } as never);
    const ctx = makeCtx([longReport("t1")]);
    const relay = await buildUpstreamRelay(ctx, {
      id: "t3",
      executionGuidance: "g",
      dependsOn: ["t1"],
    } as never);
    expect(relay).toContain("Upstream task t1");
  });
});
