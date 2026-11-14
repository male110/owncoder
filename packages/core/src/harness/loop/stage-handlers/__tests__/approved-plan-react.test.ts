import { describe, expect, it, vi } from "vitest";
import { BUILTIN_WORKFLOW, builtinAgentPipeline } from "@owncoder/settings";
import { executeToolsHandler } from "../tools.ts";
import { Tracer } from "../../../observability.ts";
import type { StageHandlerContext } from "../types.ts";

const run = vi.hoisted(() => vi.fn().mockResolvedValue({ lastAssistant: "完成", correctionCount: 0 }));
vi.mock("../../loop-strategy.ts", () => ({ resolveLoopStrategy: () => ({ run }) }));

describe("获批计划的普通任务执行", () => {
  it("分解任务交给既有 ReAct 策略，而不是计划专属执行路径", async () => {
    run.mockClear();
    const plan = "## Final Report\n### 目标\n修复登录\n### 步骤\n1. 修复并测试";
    const ctx = {
      opts: { mode: "agent", workflow: BUILTIN_WORKFLOW, userMessage: plan, llmApiKey: "test-key" },
      node: builtinAgentPipeline().nodes.find((node) => node.type === "execute_tools"),
      state: {
        planRequested: true, planApproval: "approved", approvedAgentPlan: plan,
        rawDecompose: { intent: "修复登录", tasks: [{ id: "t1", executionGuidance: "修复并测试", dependsOn: [] }] },
        turnInformationTask: null, correctionCount: 0,
      },
      messages: [{ role: "user", content: plan }], history: [], toolsFinal: [], toolCtx: {},
      memory: {}, tracer: new Tracer(), reasoningTrace: {}, taskClassification: {},
    } as unknown as StageHandlerContext;
    await executeToolsHandler.run(ctx);
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0]?.[0].opts.activeTasks).toEqual([
      expect.objectContaining({ id: "t1", executionGuidance: "修复并测试", status: "pending" }),
    ]);
    expect(run.mock.calls[0]?.[0].opts.userMessage).toBe(plan);
    expect(run.mock.calls[0]?.[0].messages).toContainEqual({ role: "user", content: plan });
  });

  it("未经批准时不调用 ReAct 策略", async () => {
    run.mockClear();
    const ctx = {
      opts: { mode: "agent", workflow: BUILTIN_WORKFLOW },
      state: { planRequested: true, planApproval: null },
    } as unknown as StageHandlerContext;
    await executeToolsHandler.run(ctx);
    expect(ctx.state.blocked).toBe(true);
    expect(run).not.toHaveBeenCalled();
  });
});
