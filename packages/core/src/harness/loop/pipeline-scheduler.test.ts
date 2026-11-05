import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PipelineNode } from "@owncoder/settings";
import type { SchedulerContext } from "./pipeline-scheduler.ts";

const { handlers, complete, inject } = vi.hoisted(() => ({
  handlers: new Map<string, { run: ReturnType<typeof vi.fn> }>(),
  complete: vi.fn(),
  inject: vi.fn(),
}));

vi.mock("./stage-handlers.ts", () => ({
  STAGE_HANDLERS: handlers,
  isModelCallingStage: () => false,
  isPostModelStage: () => false,
  injectHistoryAndUserMessage: inject,
  doPlainCompletion: complete,
}));

import { runPipelineScheduler } from "./pipeline-scheduler.ts";

function context(signal: AbortSignal): SchedulerContext {
  return {
    opts: { signal },
    state: { aborted: false, userMessageInjected: false },
    hasToolStage: false,
  } as SchedulerContext;
}

describe("pipeline cancellation", () => {
  beforeEach(() => {
    handlers.clear();
    vi.clearAllMocks();
  });

  it("does not start a fallback completion when already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const ctx = context(controller.signal);
    await runPipelineScheduler([{ id: "test", type: "context_gather", enabled: true } as PipelineNode], ctx);
    expect(ctx.state.aborted).toBe(true);
    expect(inject).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });

  it("stops after an active stage is interrupted", async () => {
    const controller = new AbortController();
    const cleanup = vi.fn();
    const run = vi.fn(() => new Promise<void>((_resolve, reject) => {
      controller.signal.addEventListener("abort", () => {
        cleanup();
        reject(new Error("aborted"));
      }, { once: true });
    }));
    handlers.set("context_gather", { run });
    const ctx = context(controller.signal);
    const running = runPipelineScheduler([{ id: "test", type: "context_gather", enabled: true } as PipelineNode], ctx);
    controller.abort();
    await running;
    expect(cleanup).toHaveBeenCalledOnce();
    expect(ctx.state.aborted).toBe(true);
    expect(complete).not.toHaveBeenCalled();
  });

  it("runs the fallback normally without cancellation", async () => {
    const ctx = context(new AbortController().signal);
    complete.mockResolvedValue("done");
    await runPipelineScheduler([], ctx);
    expect(complete).toHaveBeenCalledOnce();
    expect(ctx.state.lastAssistant).toBe("done");
    expect(ctx.state.aborted).toBe(false);
  });
});
