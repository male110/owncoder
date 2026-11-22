import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgentPlanner, resumeAgentPlan, needsAgentPlanApproval, requireAgentPlanApproval } from "../planner.ts";
import { approvePlannerPlan, readPlannerPlan, readPlanFile, revisePlannerPlan, savePlannerPlan, validatePlannerPlan } from "../../../../plans.ts";
import type { StageHandlerContext } from "../types.ts";
import { BUILTIN_WORKFLOW } from "@owncoder/settings";

// 待批准期间的普通对话走无工具补全：mock 掉流式调用，断言返回固定文本。
vi.mock("@owncoder/llm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@owncoder/llm")>();
  return {
    ...actual,
    chatCompletionStream: vi.fn(async () => ({
      choices: [{ message: { content: "这是待批准期间的普通对话回复" } }],
      usage: undefined,
    })),
  };
});

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
      workflow: BUILTIN_WORKFLOW,
      askUser: vi.fn(async (request) => request.options![0].value), onEvent: vi.fn(),
    },
    toolCtx: { workflow: BUILTIN_WORKFLOW, availableTools: new Set(["dispatch_agent"]), dispatchSubagent: vi.fn().mockResolvedValue(report) },
    // 本地 baseUrl 绕过 assertLlmAuth；doPlainCompletion 只用到 tracer 的三个方法。
    model: { id: "test-model", providerId: "test", name: "test-model", baseUrl: "http://127.0.0.1:9999" },
    tracer: { startSpan: () => "span", endSpan: vi.fn(), recordTokenUsage: vi.fn() },
    messages: [], history: [...history],
    state: { planRequested: true, planApproval: null, blocked: false, aborted: false, userMessageInjected: false },
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
    expect(needsAgentPlanApproval({ mode: "spec", activePlan: null }, true)).toBe(false);
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

  it("纯文本计划可以保存、批准并作为任务分解输入", async () => {
    const plain = "先检查登录重试逻辑，再补回归测试。";
    const saved = `## Final Report\n\n${plain}\n`;
    const first = makeContext();
    vi.mocked(first.toolCtx.dispatchSubagent!).mockResolvedValue(plain);
    await runAgentPlanner(first, call);
    expect(first.state.blocked).toBe(false);
    expect(first.state.planApproval).toBe("pending_approval");
    expect(first.state.awaitingUserConfirmation).toBe(true);
    expect(await validatePlannerPlan(root, "session-a", first.state.plannerPlan!)).toBe(saved);

    const approved = makeContext(first.history);
    await resumeAgentPlan(approved);
    expect(approved.state.planApproval).toBe("approved");
    expect(approved.opts.userMessage).toBe(saved);
    expect(await requireAgentPlanApproval(approved)).toBe(true);
  });

  it("Spec never dispatches the approval Planner or saves a plan for approval", async () => {
    const ctx = makeContext([], "请设计登录方案，不要修改代码");
    ctx.opts.mode = "spec";
    await runAgentPlanner(ctx, call);
    expect(ctx.toolCtx.dispatchSubagent).not.toHaveBeenCalled();
    expect(ctx.state.awaitingUserConfirmation).toBeUndefined();
    expect(await readPlannerPlan(root, "session-a")).toBeNull();
  });

  it.each(["spec", "agent"] as const)("Spec ignores an old %s plan without giving Agent permission to adopt a Spec plan", async (mode) => {
    const plan = await savePlannerPlan(root, "session-a", mode, report);
    const message = "把这版方案拆成待办吧";
    const ctx = makeContext([{ role: "assistant", content: `<!--plan_saved:${plan.path}-->` }], message);
    ctx.opts.mode = "spec";
    await resumeAgentPlan(ctx);
    expect(await requireAgentPlanApproval(ctx)).toBe(true);
    expect(ctx.state.awaitingUserConfirmation).toBeUndefined();
    expect(ctx.state.plannerPlan).toBeUndefined();
    expect(ctx.opts.userMessage).toBe(message);
    expect(ctx.opts.askUser).not.toHaveBeenCalled();
    expect((await readPlannerPlan(root, "session-a"))?.status).toBe("pending_approval");
    if (mode === "spec") {
      const agent = makeContext(ctx.history);
      await resumeAgentPlan(agent);
      expect(agent.state.blocked).toBe(true);
      expect(agent.opts.askUser).not.toHaveBeenCalled();
    }
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

  it("普通对话和查看请求不构成批准，改为普通对话回答（不重发计划卡片）", async () => {
    const first = makeContext(); await runAgentPlanner(first, call);
    const ctx = makeContext(first.history, "我想再看看"); await resumeAgentPlan(ctx);
    expect(ctx.state.planApproval).toBe("pending_approval");
    expect(ctx.opts.askUser).not.toHaveBeenCalled(); expect(ctx.state.awaitingUserConfirmation).toBe(true);
    // 待批准期间的输入由无工具补全回答，不再把整份计划再贴一遍。
    expect(ctx.state.lastAssistant).toBe("这是待批准期间的普通对话回复");
    expect(ctx.history.at(-1)).toMatchObject({ role: "assistant", content: "这是待批准期间的普通对话回复" });
    expect(ctx.state.lastAssistant).not.toContain("<!--plan_saved:");
    expect(ctx.history.filter((turn) => turn.role === "assistant" && turn.content.includes("<!--plan_saved:")).length).toBe(1);
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

  it("工具失败或参数无效时不保存或执行", async () => {
    const failed = makeContext(); vi.mocked(failed.toolCtx.dispatchSubagent!).mockRejectedValue(new Error("offline"));
    await runAgentPlanner(failed, call); expect(failed.state.blocked).toBe(true);
    expect(failed.state.blockedReason).toContain("只读 Planner 失败");
    const invalid = makeContext(); await runAgentPlanner(invalid, { ...call, function: { ...call.function, arguments: "{}" } });
    expect(invalid.toolCtx.dispatchSubagent).not.toHaveBeenCalled();
    const missingType = makeContext();
    await runAgentPlanner(missingType, { ...call, function: { ...call.function, arguments: JSON.stringify({ task: "调研" }) } });
    expect(missingType.state.blockedReason).toContain("只允许调用计划子代理");
    expect(missingType.toolCtx.dispatchSubagent).not.toHaveBeenCalled();
    expect(await readPlannerPlan(root, "session-a")).toBeNull();
  });

  it.each(["", "   \n\t  ", "## Final Report\n\n"])("正常返回但没有计划正文时，提交占位说明而不因格式暂停：%j", async (output) => {
    const ctx = makeContext();
    vi.mocked(ctx.toolCtx.dispatchSubagent!).mockResolvedValue(output);
    await runAgentPlanner(ctx, call);
    expect(ctx.state.blocked).toBe(false);
    expect(ctx.state.planApproval).toBe("pending_approval");
    const plan = (await readPlannerPlan(root, "session-a"))!;
    expect(await validatePlannerPlan(root, "session-a", plan)).toContain("Planner 未提供计划正文");
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

  it("UI 批准按钮路径：磁盘已批准即采信，完整计划作为用户输入进入任务分解", async () => {
    const first = makeContext(); await runAgentPlanner(first, call);
    const plan = first.state.plannerPlan!;
    // 模拟 session-plans.approvePlan：在锁内写入磁盘批准，并追加批准确认消息。
    await approvePlannerPlan(root, "session-a", plan);
    const uiHistory: StageHandlerContext["history"] = [
      ...first.history,
      { role: "user", content: "开始执行" },
      { role: "assistant", content: "✅ 计划已批准 → 已切换到 Agent 模式。" },
    ];
    const ctx = makeContext(uiHistory, "开始执行");
    await resumeAgentPlan(ctx);
    expect(ctx.state.blocked).toBe(false);
    expect(ctx.state.planApproval).toBe("approved");
    expect(ctx.state.approvedAgentPlan).toBe(`${report}\n`);
    // 既定契约：任务分解收到的用户输入是获批计划的完整内容。
    expect(ctx.opts.userMessage).toBe(`${report}\n`);
    expect(ctx.opts.activePlan).toEqual({ path: plan.path, content: `${report}\n` });
    expect(ctx.opts.askUser).not.toHaveBeenCalled();
    expect(await requireAgentPlanApproval(ctx)).toBe(true);

    const freshExecution = makeContext(uiHistory, "请继续处理下一步");
    await resumeAgentPlan(freshExecution);
    expect(freshExecution.state.planApproval).toBe("approved");
    expect(await requireAgentPlanApproval(freshExecution)).toBe(true);
  });

  it("未批准计划在执行边界仍被阻止", async () => {
    const first = makeContext();
    await runAgentPlanner(first, call);
    const unapproved = makeContext(first.history, "开始执行");
    unapproved.state.planRequested = true;
    await expect(requireAgentPlanApproval(unapproved)).resolves.toBe(false);
    expect(unapproved.state.blocked).toBe(true);
  });

  it("UI 批准按钮路径：磁盘批准过期或被替换时仍拒绝", async () => {
    const first = makeContext(); await runAgentPlanner(first, call);
    const plan = first.state.plannerPlan!;
    await approvePlannerPlan(root, "session-a", plan);
    // 批准后生成新版：旧批准失效，UI 旧界面提交旧版本必须被拒绝。
    await revisePlannerPlan(root, "session-a", plan);
    await savePlannerPlan(root, "session-a", "agent", `${report}\n新版`, plan);
    const ctx = makeContext(first.history, "开始执行");
    await resumeAgentPlan(ctx);
    expect(ctx.state.blocked).toBe(true);
    expect(ctx.state.planApproval).toBe("unavailable");
    expect(ctx.opts.askUser).not.toHaveBeenCalled();
  });

  it("拒绝非 Planner 代理，中止时不派发", async () => {
    const ctx = makeContext();
    await runAgentPlanner(ctx, { ...call, function: { ...call.function, arguments: JSON.stringify({ agent_type: "Explore", task: "调研" }) } });
    expect(ctx.toolCtx.dispatchSubagent).not.toHaveBeenCalled();
    const aborted = makeContext(); aborted.opts.signal = AbortSignal.abort(); await runAgentPlanner(aborted, call);
    expect(aborted.state.aborted).toBe(true); expect(aborted.toolCtx.dispatchSubagent).not.toHaveBeenCalled();
  });
});

describe("Planner 报告消费", () => {


  it.each([
    ["## Final Report\n### 思路\n- 检查认证边界\n- 修复登录重试并测试", ""],
    ["先检查登录重试逻辑，再补回归测试。", "## Final Report\n\n"],
    ["先查现状。\n\n## Final Report\n\n- 补回归测试", "## Final Report\n\n"],
  ])("不要求固定章节、标题或编号，并保留正文：%j", async (output, heading) => {
    const ctx = makeContext();
    vi.mocked(ctx.toolCtx.dispatchSubagent!).mockResolvedValue(` \n${output}\n `);
    await runAgentPlanner(ctx, call);
    expect(ctx.state.blocked).toBe(false);
    expect(ctx.state.planApproval).toBe("pending_approval");
    const plan = (await readPlannerPlan(root, "session-a"))!;
    expect(await validatePlannerPlan(root, "session-a", plan)).toBe(`${heading}${output}\n`);
  });

  it("向 Planner 调用转发分解阶段相关历史", async () => {
    const ctx = makeContext();
    ctx.state.rawDecompose = {
      intent: "规划认证改动",
      relevantHistory: "packages/auth/src/login.ts:12 已确认入口",
      tasks: [],
    };
    await runAgentPlanner(ctx, call);
    expect(ctx.toolCtx.dispatchSubagent).toHaveBeenCalledWith(expect.objectContaining({
      agentType: "Planner",
      relevantHistory: "packages/auth/src/login.ts:12 已确认入口",
    }));
  });

  it("空分解历史不向 Planner 添加占位值", async () => {
    const ctx = makeContext();
    await runAgentPlanner(ctx, call);
    expect(ctx.toolCtx.dispatchSubagent).toHaveBeenCalledWith(expect.objectContaining({
      agentType: "Planner",
      relevantHistory: undefined,
    }));
  });

  it.each([
    "[Planner partial result: subagent budget exhausted; no plan was produced]",
    `[Planner partial result: reached the iteration limit; findings below may be incomplete]\n\n${report}`,
    "[Planner partial result: request timed out]",
  ])("Planner 不完整结果明确暂停：%s", async (partial) => {
    const ctx = makeContext();
    vi.mocked(ctx.toolCtx.dispatchSubagent!).mockResolvedValue(partial);
    await runAgentPlanner(ctx, call);
    expect(ctx.state.blocked).toBe(true);
    expect(ctx.state.blockedReason).toContain("只读 Planner 未完成计划");
    expect(ctx.state.blockedReason).not.toContain("缺少");
    expect(await readPlannerPlan(root, "session-a")).toBeNull();
  });
});
