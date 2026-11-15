import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgentPlanner, resumeAgentPlan, needsAgentPlanApproval, requireAgentPlanApproval, validatePlannerReport } from "../planner.ts";
import { approvePlannerPlan, readPlannerPlan, readPlanFile, revisePlannerPlan, savePlannerPlan, validatePlannerPlan } from "../../../../plans.ts";
import type { StageHandlerContext } from "../types.ts";
import { BUILTIN_WORKFLOW } from "@owncoder/settings";

const report = [
  "## Final Report", "### 目标", "实现登录重试", "### 步骤",
  "1. 检查认证边界", "2. 修复登录重试并测试",
  "### 相关文件", "packages/auth/src/login.ts: 检索到入口",
  "### 风险与不确定性", "重试语义需要核对",
  "### 验证方式", "运行相关测试",
].join("\n");

let root: string;
function makeContext(history: StageHandlerContext["history"] = [], input = "批准执行"): StageHandlerContext {
  return {
    opts: {
      workspaceRoot: root, sessionId: "session-a", mode: "agent", activePlan: null, history, userMessage: input,
      askUser: vi.fn(async (request) => request.options![0].value), onEvent: vi.fn(),
    },
    toolCtx: { workflow: BUILTIN_WORKFLOW, availableTools: new Set(["dispatch_agent"]), dispatchSubagent: vi.fn().mockResolvedValue(report) },
    messages: [], history: [...history],
    state: { planRequested: true, planApproval: null, blocked: false, aborted: false },
  } as unknown as StageHandlerContext;
}
const call = {
  id: "call-1", type: "function" as const,
  function: { name: "dispatch_agent", arguments: JSON.stringify({ agent_type: "Planner", task: "只读调研并生成计划" }) },
};

beforeEach(async () => { root = await fs.mkdtemp(join(tmpdir(), "owncoder-planner-test-")); });
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); });

describe("版本化计划保存与审批", () => {
  it("只有原生 Planner 请求触发初次审批要求", () => {
    expect(needsAgentPlanApproval({ mode: "agent", activePlan: null }, true)).toBe(true);
    expect(needsAgentPlanApproval({ mode: "agent", activePlan: null }, false)).toBe(false);
    expect(needsAgentPlanApproval({ mode: "agent", activePlan: {} as never }, true)).toBe(false);
    expect(needsAgentPlanApproval({ mode: "spec", activePlan: null }, true)).toBe(true);
  });

  it("保存完整文件并交付正确版本卡片，同轮不询问批准也不分解实施", async () => {
    const ctx = makeContext();
    await runAgentPlanner(ctx, call);
    const plan = (await readPlannerPlan(root, "session-a"))!;
    expect(plan.version).toBe(1);
    expect(await readPlanFile(root, plan.path, "session-a")).toBe(`${report}\n`);
    expect(await validatePlannerPlan(root, "session-a", plan)).toBe(`${report}\n`);
    expect(ctx.state.lastAssistant).toContain(`\n\n<!--plan_saved:${plan.path}-->`);
    expect(ctx.state.lastAssistant).toContain(plan.digest);
    expect(ctx.state.planApproval).toBe("pending_approval");
    expect(ctx.state.awaitingUserConfirmation).toBe(true);
    expect(ctx.opts.askUser).not.toHaveBeenCalled();
    expect(ctx.state.approvedAgentPlan).toBeUndefined();
    expect(ctx.state.rawDecompose).toBeUndefined();
    expect(ctx.messages).toEqual([]);
    expect(await requireAgentPlanApproval(ctx)).toBe(false);
  });

  it("下一轮绑定版本令牌批准，并在执行边界重新读取", async () => {
    const first = makeContext();
    await runAgentPlanner(first, call);
    const ctx = makeContext(first.history);
    await resumeAgentPlan(ctx);
    expect(ctx.state.planApproval).toBe("approved");
    expect(ctx.state.approvedAgentPlan).toBe(`${report}\n`);
    expect(await requireAgentPlanApproval(ctx)).toBe(true);
    const plan = (await readPlannerPlan(root, "session-a"))!;
    expect(plan.approval).toMatchObject({ planId: plan.planId, version: 1, digest: plan.digest, path: plan.path });
    await fs.writeFile(join(root, plan.path), "被外部改写");
    expect(await requireAgentPlanApproval(ctx)).toBe(false);
  });

  it("Spec 批准仍只授权只读设计，不能作为 Agent 实施批准", async () => {
    const first = makeContext([], "请设计登录方案，不要修改代码"); first.opts.mode = "spec";
    await runAgentPlanner(first, call);
    const spec = makeContext(first.history, "批准计划"); spec.opts.mode = "spec";
    await resumeAgentPlan(spec);
    expect(spec.state.planApproval).toBe("approved");
    expect(spec.opts.userMessage).toBe("请设计登录方案，不要修改代码");
    expect(spec.opts.askUser).toHaveBeenCalledWith(expect.objectContaining({ question: expect.stringContaining("不修改源代码") }));
    const agent = makeContext(first.history);
    await resumeAgentPlan(agent);
    expect(agent.state.blocked).toBe(true);
    expect(agent.opts.askUser).not.toHaveBeenCalled();
  });

  it("修改已批准计划保存完整新版、更新引用并使旧批准失效", async () => {
    const first = makeContext(); await runAgentPlanner(first, call);
    const approved = makeContext(first.history); await resumeAgentPlan(approved);
    const old = approved.state.plannerPlan!;
    const revision = makeContext(first.history, "请补充回滚方案");
    const revised = report.replace("2. 修复登录重试并测试", "2. 修复登录重试并测试\n3. 补充回滚方案");
    vi.mocked(revision.toolCtx.dispatchSubagent!).mockResolvedValue(revised);
    await resumeAgentPlan(revision);
    const latest = (await readPlannerPlan(root, "session-a"))!;
    expect(latest.planId).toBe(old.planId); expect(latest.version).toBe(2);
    expect(latest.status).toBe("pending_approval"); expect(latest.approval).toBeUndefined();
    expect(await readPlanFile(root, latest.path, "session-a")).toBe(`${revised}\n`);
    expect(revision.state.lastAssistant).toContain(`<!--plan_saved:${latest.path}-->`);
    expect(revision.state.awaitingUserConfirmation).toBe(true);
    expect(revision.opts.askUser).not.toHaveBeenCalled();
    expect(await requireAgentPlanApproval(approved)).toBe(false);
    expect(await readPlanFile(root, old.path, "session-a")).toBe(`${report}\n`);
    const stale = makeContext(first.history); await resumeAgentPlan(stale);
    expect(stale.state.blocked).toBe(true); expect(stale.opts.askUser).not.toHaveBeenCalled();
  });

  it("批准等待期间生成新版，旧令牌不得批准新版", async () => {
    const first = makeContext(); await runAgentPlanner(first, call);
    const old = first.state.plannerPlan!;
    const ctx = makeContext(first.history);
    ctx.opts.askUser = vi.fn(async (request) => {
      await revisePlannerPlan(root, "session-a", old);
      await savePlannerPlan(root, "session-a", "agent", `${report}\n新版补充`, old);
      return request.options![0].value;
    });
    await resumeAgentPlan(ctx);
    expect(ctx.state.blocked).toBe(true);
    expect((await readPlannerPlan(root, "session-a"))!.approval).toBeUndefined();
    expect(await requireAgentPlanApproval(ctx)).toBe(false);
  });

  it("并发批准与修改最多一方成功，最终修订状态不允许实施", async () => {
    const plan = await savePlannerPlan(root, "session-a", "agent", report);
    const results = await Promise.allSettled([approvePlannerPlan(root, "session-a", plan), revisePlannerPlan(root, "session-a", plan)]);
    expect(results.some((result) => result.status === "rejected")).toBe(true);
    await revisePlannerPlan(root, "session-a", plan);
    await expect(validatePlannerPlan(root, "session-a", plan, true)).rejects.toThrow();
  });

  it("保存失败不展示虚假引用、不进入等待批准", async () => {
    await fs.writeFile(join(root, ".owncoder"), "阻止目录创建");
    const ctx = makeContext(); await runAgentPlanner(ctx, call);
    expect(ctx.state.blocked).toBe(true); expect(ctx.state.planApproval).toBe("unavailable");
    expect(ctx.state.lastAssistant ?? "").not.toContain("<!--plan_saved:");
    expect(ctx.state.awaitingUserConfirmation).not.toBe(true);
    expect(ctx.opts.askUser).not.toHaveBeenCalled();
  });

  it.each(["missing", "changed", "reference"])("文件缺失、内容变化或引用无效时阻断：%s", async (kind) => {
    const first = makeContext(); await runAgentPlanner(first, call);
    const plan = first.state.plannerPlan!;
    if (kind === "missing") await fs.unlink(join(root, plan.path));
    if (kind === "changed") await fs.writeFile(join(root, plan.path), "篡改");
    if (kind === "reference") first.history[0].content = first.history[0].content.replace(plan.path, ".owncoder/plans/wrong.md");
    const ctx = makeContext(first.history); await resumeAgentPlan(ctx);
    expect(ctx.state.blocked).toBe(true); expect(ctx.opts.askUser).not.toHaveBeenCalled();
  });

  it("普通对话和查看请求不构成批准", async () => {
    const first = makeContext(); await runAgentPlanner(first, call);
    const ctx = makeContext(first.history, "我想再看看"); await resumeAgentPlan(ctx);
    expect(ctx.state.planApproval).toBe("pending_approval");
    expect(ctx.opts.askUser).not.toHaveBeenCalled(); expect(ctx.state.awaitingUserConfirmation).toBe(true);
  });

  it("非版本令牌批准无效，缺少确认通道也阻断", async () => {
    const first = makeContext(); await runAgentPlanner(first, call);
    const ctx = makeContext(first.history); ctx.opts.askUser = vi.fn().mockResolvedValue("approve");
    await resumeAgentPlan(ctx); expect(ctx.state.blocked).toBe(true);
    const other = makeContext(); other.opts.sessionId = "session-b"; await runAgentPlanner(other, call);
    const unavailable = makeContext(other.history); unavailable.opts.sessionId = "session-b"; delete unavailable.opts.askUser;
    await resumeAgentPlan(unavailable); expect(unavailable.state.blocked).toBe(true);
  });

  it("审批弹窗中的修改意见保存完整新版，同轮不实施", async () => {
    const first = makeContext(); await runAgentPlanner(first, call);
    const ctx = makeContext(first.history);
    ctx.opts.activePlan = { path: first.state.plannerPlan!.path, content: report };
    ctx.opts.askUser = vi.fn().mockResolvedValue("请补充回滚步骤");
    vi.mocked(ctx.toolCtx.dispatchSubagent!).mockResolvedValue(`${report}\n完整新版的回滚步骤`);
    await resumeAgentPlan(ctx);
    const plan = (await readPlannerPlan(root, "session-a"))!;
    expect(plan.version).toBe(2); expect(plan.approval).toBeUndefined();
    expect(ctx.state.awaitingUserConfirmation).toBe(true);
    expect(ctx.state.approvedAgentPlan).toBeUndefined();
    expect(ctx.state.lastAssistant).toContain(`<!--plan_saved:${plan.path}-->`);
  });

  it("计划元数据缺失时不能从旧引用继续执行", async () => {
    const first = makeContext(); await runAgentPlanner(first, call);
    await fs.rm(join(root, ".owncoder/plans/.active"), { recursive: true });
    const ctx = makeContext(first.history); await resumeAgentPlan(ctx);
    expect(ctx.state.blocked).toBe(true); expect(ctx.opts.askUser).not.toHaveBeenCalled();
  });

  it("保存后的回读不一致不交付可批准引用", async () => {
    const original = fs.readFile.bind(fs);
    vi.spyOn(fs, "readFile").mockImplementation(((...args: Parameters<typeof fs.readFile>) => {
      if (String(args[0]).endsWith("-v1.md")) return Promise.resolve("损坏的回读");
      return original(...args);
    }) as typeof fs.readFile);
    const ctx = makeContext(); await runAgentPlanner(ctx, call);
    expect(ctx.state.blocked).toBe(true); expect(ctx.state.planApproval).toBe("unavailable");
    expect(ctx.state.lastAssistant).not.toContain("<!--plan_saved:");
  });

  it("工具失败、参数或报告无效均不保存或执行", async () => {
    const failed = makeContext(); vi.mocked(failed.toolCtx.dispatchSubagent!).mockRejectedValue(new Error("offline"));
    await runAgentPlanner(failed, call); expect(failed.state.blocked).toBe(true);
    const invalid = makeContext(); await runAgentPlanner(invalid, { ...call, function: { ...call.function, arguments: "{}" } });
    expect(invalid.toolCtx.dispatchSubagent).not.toHaveBeenCalled();
    const bad = makeContext(); vi.mocked(bad.toolCtx.dispatchSubagent!).mockResolvedValue("## Final Report\n### 目标\n无步骤");
    await runAgentPlanner(bad, call); expect(bad.state.blocked).toBe(true);
    expect(validatePlannerReport("## Final Report\n### 目标\n无步骤").missing).toContain("步骤");
    expect(await readPlannerPlan(root, "session-a")).toBeNull();
  });

  it("跨会话卡片、批准令牌和缓存执行状态不能复用", async () => {
    const first = makeContext(); await runAgentPlanner(first, call);
    const foreign = makeContext(first.history); foreign.opts.sessionId = "session-b";
    await resumeAgentPlan(foreign);
    expect(foreign.state.blocked).toBe(true);
    expect(foreign.state.plannerPlan).toBeUndefined();
    expect(foreign.state.lastAssistant).not.toContain("<!--plan_saved:");
    expect(foreign.opts.askUser).not.toHaveBeenCalled();
    const second = makeContext(); second.opts.sessionId = "session-b";
    await runAgentPlanner(second, call);
    const planA = first.state.plannerPlan!;
    const copiedToken = `approve:${encodeURIComponent("session-a")}:${planA.planId}:${planA.version}:${planA.digest}`;
    const approval = makeContext(second.history); approval.opts.sessionId = "session-b";
    approval.opts.askUser = vi.fn().mockResolvedValue(copiedToken);
    await resumeAgentPlan(approval);
    expect(approval.state.planApproval).not.toBe("approved");
    const cached = makeContext(); cached.opts.sessionId = "session-c";
    cached.state.planRequested = false;
    cached.state.plannerPlan = planA;
    cached.state.planApproval = "approved";
    cached.state.approvedAgentPlan = report;
    expect(await requireAgentPlanApproval(cached)).toBe(false);
  });

  it("拒绝非 Planner 代理，中止时不派发", async () => {
    const ctx = makeContext();
    await runAgentPlanner(ctx, { ...call, function: { ...call.function, arguments: JSON.stringify({ agent_type: "Explore", task: "调研" }) } });
    expect(ctx.toolCtx.dispatchSubagent).not.toHaveBeenCalled();
    const aborted = makeContext(); aborted.opts.signal = AbortSignal.abort(); await runAgentPlanner(aborted, call);
    expect(aborted.state.aborted).toBe(true); expect(aborted.toolCtx.dispatchSubagent).not.toHaveBeenCalled();
  });
});
