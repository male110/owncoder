import { describe, expect, it, vi } from "vitest";
import { runAgentPlanner, needsAgentPlanApproval, requireAgentPlanApproval, validatePlannerReport } from "../planner.ts";
import type { StageHandlerContext } from "../types.ts";
import { BUILTIN_WORKFLOW } from "@owncoder/settings";

const report = [
  "## Final Report", "### 目标", "实现登录重试", "### 步骤",
  "1. 检查认证边界", "2. 修复登录重试并测试",
  "### 相关文件", "packages/auth/src/login.ts: 检索到入口",
  "### 风险与不确定性", "重试语义需要核对",
  "### 验证方式", "运行相关测试",
].join("\n");

function makeContext(answer = "approve"): StageHandlerContext {
  return {
    opts: { mode: "agent", activePlan: null, askUser: vi.fn().mockResolvedValue(answer), onEvent: vi.fn() },
    toolCtx: { workflow: BUILTIN_WORKFLOW, availableTools: new Set(["dispatch_agent"]), dispatchSubagent: vi.fn().mockResolvedValue(report) },
    messages: [], history: [],
    state: { planRequested: true, planApproval: null, blocked: false, aborted: false },
  } as never;
}

const call = {
  id: "call-1", type: "function" as const,
  function: { name: "dispatch_agent", arguments: JSON.stringify({ agent_type: "Explore", task: "只读调研并生成计划" }) },
};

describe("原生子代理计划调用与审批", () => {
  it("仅原生调用触发审批，复杂度和 JSON 字段不触发", () => {
    expect(needsAgentPlanApproval({ mode: "agent", activePlan: null }, true)).toBe(true);
    expect(needsAgentPlanApproval({ mode: "agent", activePlan: null }, false)).toBe(false);
    expect(needsAgentPlanApproval({ mode: "agent", activePlan: {} as never }, true)).toBe(false);
    expect(needsAgentPlanApproval({ mode: "spec", activePlan: null }, true)).toBe(false);
  });

  it("审批前不能进入可写边界；批准后保留完整计划供正常分解", async () => {
    const ctx = makeContext();
    expect(requireAgentPlanApproval(ctx)).toBe(false);
    ctx.state.blocked = false;
    ctx.state.planApproval = null;
    await runAgentPlanner(ctx, call);
    expect(ctx.toolCtx.dispatchSubagent).toHaveBeenCalledWith({ agentType: "Explore", task: "只读调研并生成计划", thoroughness: "medium" });
    expect(ctx.state.planApproval).toBe("approved");
    expect(ctx.state.approvedAgentPlan).toBe(report);
    expect(ctx.state.rawDecompose).toBeUndefined();
    expect(ctx.messages).toEqual([]);
    expect(requireAgentPlanApproval(ctx)).toBe(true);
  });

  it.each(["reject", "请先补充回滚方案"])("拒绝或修改计划 %s 不生成任务", async (answer) => {
    const ctx = makeContext(answer);
    await runAgentPlanner(ctx, call);
    expect(ctx.state.blocked).toBe(true);
    expect(ctx.state.rawDecompose).toBeUndefined();
    expect(requireAgentPlanApproval(ctx)).toBe(false);
  });

  it("工具失败、无效参数、无效计划均不进入审批或执行", async () => {
    const failed = makeContext();
    (failed.toolCtx.dispatchSubagent as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("offline"));
    await runAgentPlanner(failed, call);
    expect(failed.state.blocked).toBe(true);
    expect(failed.opts.askUser).not.toHaveBeenCalled();

    const invalidArgs = makeContext();
    await runAgentPlanner(invalidArgs, { ...call, function: { ...call.function, arguments: "{}" } });
    expect(invalidArgs.state.blocked).toBe(true);
    expect(invalidArgs.toolCtx.dispatchSubagent).not.toHaveBeenCalled();

    const invalidReport = makeContext();
    (invalidReport.toolCtx.dispatchSubagent as ReturnType<typeof vi.fn>).mockResolvedValue("## Final Report\n### 目标\n无步骤");
    await runAgentPlanner(invalidReport, call);
    expect(invalidReport.state.blocked).toBe(true);
    expect(invalidReport.opts.askUser).not.toHaveBeenCalled();
    expect(validatePlannerReport("## Final Report\n### 目标\n无步骤").missing).toContain("步骤");
  });

  it("中止及确认通道缺失时 fail closed", async () => {
    const aborted = makeContext();
    (aborted.opts as { signal?: AbortSignal }).signal = AbortSignal.abort();
    await runAgentPlanner(aborted, call);
    expect(aborted.state.aborted).toBe(true);
    expect(aborted.toolCtx.dispatchSubagent).not.toHaveBeenCalled();

    const unavailable = makeContext();
    delete (unavailable.opts as { askUser?: unknown }).askUser;
    await runAgentPlanner(unavailable, call);
    expect(unavailable.state.blocked).toBe(true);
    expect(unavailable.state.rawDecompose).toBeUndefined();
  });
});
