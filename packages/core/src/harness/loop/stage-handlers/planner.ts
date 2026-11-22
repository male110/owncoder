import type { StageHandlerContext } from "./types.ts";
import type { AgentLoopOpts } from "../types.ts";
import { executeTool } from "../../execute.ts";
import type { ToolCall } from "@owncoder/llm";
import { PLANNER_SUBAGENT_TYPE } from "../../subagent/planner-subagent.ts";
import { approvePlannerPlan, readPlannerPlan, revisePlannerPlan, savePlannerPlan, validatePlannerPlan, type PlannerPlan } from "../../../plans.ts";

// `toolCtx` 是必需成员：planner 交付计划走非工具路径（直接调 savePlannerPlan），
// 不会经过 save-plan/write-file 等工具的 `ctx.lastPlanPath` 赋值点。若不在这里
// 补写，`AgentLoopResult.lastPlanPath`（loop.ts 中 `finish()` 读取 toolCtx）恒为空，
// 渲染端 `useChatActions` 的 `refreshPlans(sid)` 就不会被触发，计划卡片拿不到
// 计划元数据，「批准计划」按钮只能靠切换会话重新枚举磁盘才出现。
type PlanContext = Pick<StageHandlerContext, "opts" | "state" | "history" | "toolCtx">;

function failPlan(ctx: PlanContext, error: unknown): void {
  ctx.state.planApproval = "unavailable";
  ctx.state.approvedAgentPlan = undefined;
  ctx.state.blocked = true;
  ctx.state.blockedReason = `计划校验或保存失败，未授权执行：${error instanceof Error ? error.message : String(error)}`;
  ctx.state.lastAssistant = ctx.state.blockedReason;
  ctx.history.push({ role: "assistant", content: ctx.state.lastAssistant });
  ctx.opts.onEvent?.({ type: "assistant_delta", text: ctx.state.lastAssistant });
}

function deliverPlan(ctx: PlanContext, plan: PlannerPlan, content: string): void {
  ctx.state.plannerPlan = plan;
  ctx.state.planApproval = "pending_approval";
  ctx.state.approvedAgentPlan = undefined;
  ctx.state.awaitingUserConfirmation = true;
  ctx.state.lastAssistant = [
    `计划已保存：${plan.planId}，版本 v${plan.version}，摘要 ${plan.digest}。`,
    content.trim(),
    "请打开计划查看；下一轮明确批准执行或提出修改意见。本轮未实施计划内容。",
  ].join("\n\n") + `\n\n<!--plan_saved:${plan.path}-->`;
  // 计划刚刚保存成功：把路径记到本轮 toolCtx 上，`AgentLoopResult.lastPlanPath`
  // 会随之带值返回渲染端，触发 plansBySession 的即时刷新，使计划卡片的
  // 「批准计划」按钮无需切换会话即可出现。
  ctx.toolCtx.lastPlanPath = plan.path;
  ctx.history.push({ role: "assistant", content: ctx.state.lastAssistant });
  ctx.opts.onEvent?.({ type: "assistant_delta", text: ctx.state.lastAssistant });
}

/**
 * 计划待批准期间的普通对话（桌面 UI 有独立批准按钮）：不再重发计划卡片，
 * 而是注入历史后做一次无工具补全来回答用户。回答完仍保持待批准状态——
 * 不进入执行流水线，计划未批准不实施任何代码。
 * 从 "./index.js" 动态导入以避开循环依赖（index.ts 导入本模块）。
 */
async function answerPlanPendingChat(
  ctx: Omit<StageHandlerContext, "node">,
  plan: PlannerPlan,
): Promise<void> {
  const { opts, state } = ctx;
  if (opts.signal?.aborted) { state.aborted = true; return; }
  state.plannerPlan = plan;
  state.planApproval = "pending_approval";
  state.approvedAgentPlan = undefined;
  const { injectHistoryAndUserMessage, doPlainCompletion } = await import("./index.js");
  if (!state.userMessageInjected) {
    await injectHistoryAndUserMessage(ctx);
    state.userMessageInjected = true;
  }
  // 明确本轮边界：只回答，不实施；批准由 UI 按钮或下一轮批准令牌完成。
  ctx.messages.push({
    role: "system",
    content: `当前有计划待批准（${plan.path}，v${plan.version}）。本轮只需回答用户的问题或澄清计划内容，不要承诺或实施任何代码变更；批准后才会进入执行。`,
  });
  state.lastAssistant = await doPlainCompletion(ctx);
  state.awaitingUserConfirmation = true;
}

export async function requestAgentPlanApproval(ctx: PlanContext, planText: string): Promise<void> {
  const { opts, state } = ctx;
  if (opts.signal?.aborted) {
    state.aborted = true;
    return;
  }
  try {
    if (opts.mode !== "agent") return;
    const plan = await savePlannerPlan(opts.workspaceRoot, opts.sessionId, opts.mode, planText, state.plannerPlan, opts.userMessage);
    const content = await validatePlannerPlan(opts.workspaceRoot, opts.sessionId, plan);
    if (opts.signal?.aborted) {
      state.aborted = true;
      return;
    }
    deliverPlan(ctx, plan, content);
  } catch (error) {
    failPlan(ctx, error);
  }
}

export function needsAgentPlanApproval(
  opts: Pick<AgentLoopOpts, "mode" | "activePlan">,
  requested: boolean | undefined,
): boolean {
  return opts.mode === "agent" && !opts.activePlan && requested === true;
}

/** 即使流水线省略任务分解，也在进入工具循环前重新校验磁盘版本和批准。 */
export async function requireAgentPlanApproval(ctx: Pick<StageHandlerContext, "opts" | "state">): Promise<boolean> {
  if (ctx.opts.mode !== "agent") return true;
  try {
    const current = await readPlannerPlan(ctx.opts.workspaceRoot, ctx.opts.sessionId);
    if (ctx.opts.singleSpecTask) {
      // This task has its own approval. Do not adopt a Planner plan, but
      // honor any unresolved Agent Planner approval in the same session.
      if (current?.mode === "agent") {
        await validatePlannerPlan(ctx.opts.workspaceRoot, ctx.opts.sessionId, current, true);
      } else if (!current && ctx.opts.history.some((turn) =>
        turn.role === "assistant" && turn.content.includes("<!--plan_saved:.owncoder/plans/"))) {
        throw new Error("会话存在计划引用，但当前版本元数据缺失");
      }
      return true;
    }
    if (ctx.state.plannerPlan && ctx.state.plannerPlan.sessionId !== ctx.opts.sessionId) throw new Error("计划不属于当前会话");
    if (!current && !ctx.state.planRequested && !ctx.state.plannerPlan && !ctx.state.approvedAgentPlan) return true;
    if (current && current.mode === ctx.opts.mode && ctx.state.planApproval === "approved"
      && ctx.state.plannerPlan && ctx.state.approvedAgentPlan?.trim()) {
      const content = await validatePlannerPlan(ctx.opts.workspaceRoot, ctx.opts.sessionId, ctx.state.plannerPlan, true);
      if (content === ctx.state.approvedAgentPlan) return true;
    }
    throw new Error("复杂任务未完成当前版本的有效计划审批");
  } catch (error) {
    ctx.state.planApproval = "unavailable";
    ctx.state.blocked = true;
    if (ctx.opts.singleSpecTask) ctx.state.specTaskApprovalBlocked = true;
    ctx.state.blockedReason = `执行已暂停：${error instanceof Error ? error.message : String(error)}`;
    return false;
  }
}

async function generatePlanRevision(ctx: Omit<StageHandlerContext, "node">, plan: PlannerPlan, content: string, feedback: string): Promise<void> {
  await revisePlannerPlan(ctx.opts.workspaceRoot, ctx.opts.sessionId, plan);
  ctx.state.planApproval = "needs_revision";
  ctx.state.approvedAgentPlan = undefined;
  ctx.state.planApprovalFeedback = feedback;
  await runAgentPlanner(ctx, {
    id: `revise-${plan.planId}-${plan.version}`, type: "function",
    function: { name: "dispatch_agent", arguments: JSON.stringify({ agent_type: PLANNER_SUBAGENT_TYPE, task: [
      "只读修改下列完整计划，融合用户修改要求，返回完整新版而非增量。保留目标、编号步骤、相关文件与证据、风险与不确定性、验证方式五段结构。不得实施计划。",
      `当前计划 v${plan.version}：\n${content}`, `用户修改要求：\n${feedback}`,
    ].join("\n\n") }) },
  });
}

/** 从既有计划目录恢复；计划生成轮不调用此处的审批分支。 */
export async function resumeAgentPlan(ctx: Omit<StageHandlerContext, "node">): Promise<void> {
  const { opts, state } = ctx;
  if (opts.leanPipeline || opts.readOnly || opts.mode !== "agent") return;
  try {
    const plan = await readPlannerPlan(opts.workspaceRoot, opts.sessionId);
    if (!plan) {
      if (opts.history.some((turn) => turn.role === "assistant" && turn.content.includes("<!--plan_saved:.owncoder/plans/"))) {
        throw new Error("会话存在计划引用，但当前版本元数据缺失");
      }
      return;
    }
    state.planRequested = true;
    state.plannerPlan = plan;
    if (plan.mode !== opts.mode) throw new Error("计划模式不匹配，请回到原模式处理；Spec 批准不授权代码实施");
    const content = await validatePlannerPlan(opts.workspaceRoot, opts.sessionId, plan, false, true);
    if (opts.signal?.aborted) { state.aborted = true; return; }
    const input = opts.userMessage.trim();
    const revision = /修改|调整|补充|纠正|更正|改成|改为|增加|删除|修订|revise|change|update/i.test(input);
    if (revision) {
      await generatePlanRevision(ctx, plan, content, input);
      return;
    }
    // Desktop approval is persisted before the follow-up execution turn. Restore that
    // exact revision without requiring the user to repeat an approval phrase.
    if (plan.status === "approved") {
      const approvedContent = await validatePlannerPlan(opts.workspaceRoot, opts.sessionId, plan, true);
      if (opts.signal?.aborted) { state.aborted = true; return; }
      state.approvedAgentPlan = approvedContent;
      state.planApproval = "approved";
      state.plannerPlan = plan;
      if (opts.activePlan?.path !== plan.path) {
        opts.activeTasks = undefined;
        opts.currentTaskId = null;
        opts.taskRunState = null;
        state.taskRunState = null;
      }
      opts.activePlan = { path: plan.path, content: approvedContent };
      opts.userMessage = approvedContent;
      return;
    }
    const approve = /^(?:approve|approved|批准(?:执行|计划)?|同意(?:执行|计划)?|实施|继续|开始执行|按计划执行|执行计划)[。！!\s]*$/i.test(input);
    if (!approve) {
      if (/^(?:reject|拒绝(?:计划)?|不同意|取消)[。！!\s]*$/i.test(input)) {
        await revisePlannerPlan(opts.workspaceRoot, opts.sessionId, plan);
        state.planApproval = "rejected";
        state.blocked = true;
        state.blockedReason = "用户拒绝计划，旧批准已失效；请提出修改要求";
        state.lastAssistant = state.blockedReason;
        ctx.history.push({ role: "assistant", content: state.lastAssistant });
        opts.onEvent?.({ type: "assistant_delta", text: state.lastAssistant });
      } else {
        // 桌面 UI 有独立批准按钮：非批准/拒绝/修订的输入按普通对话回答，
        // 不重发计划卡片，也不进入未批准计划的执行流水线。
        await answerPlanPendingChat(ctx, plan);
      }
      return;
    }
    const viewed = [...opts.history].reverse().find((turn) => turn.role === "assistant");
    if (plan.status === "revising" || !viewed?.content.includes(`<!--plan_saved:${plan.path}-->`)
      || !viewed.content.includes(plan.digest) || !viewed.content.includes(plan.planId)
      || !viewed.content.includes(`v${plan.version}`)) throw new Error("批准未对应当前展示的计划版本，请重新查看当前计划");
    if (!opts.askUser) throw new Error("当前宿主未提供用户确认通道");
    const token = `approve:${encodeURIComponent(opts.sessionId)}:${plan.planId}:${plan.version}:${plan.digest}`;
    const answer = await opts.askUser({
      question: `批准后进入代码实施：${plan.path}（v${plan.version}，摘要 ${plan.digest}）。`,
      options: [
        { label: "批准执行", value: token },
        { label: "拒绝计划", value: "reject" },
      ],
      allowFreeText: true, placeholder: "输入修改意见将生成完整新版，并重新等待批准",
    });
    if (opts.signal?.aborted) { state.aborted = true; return; }
    if (answer !== token) {
      if (answer.trim() && answer !== "reject" && !/^(?:approve|approved|批准(?:执行|计划)?|同意)$/i.test(answer.trim())) {
        await generatePlanRevision(ctx, plan, content, answer);
        return;
      }
      await revisePlannerPlan(opts.workspaceRoot, opts.sessionId, plan);
      state.planApprovalFeedback = answer;
      state.planApproval = answer === "reject" ? "rejected" : "needs_revision";
      state.blocked = true;
      state.blockedReason = "未批准当前版本，已撤销旧批准；请下一轮提交修改要求";
      state.lastAssistant = state.blockedReason;
      ctx.history.push({ role: "assistant", content: state.lastAssistant });
      opts.onEvent?.({ type: "assistant_delta", text: state.lastAssistant });
      return;
    }
    state.approvedAgentPlan = await approvePlannerPlan(opts.workspaceRoot, opts.sessionId, plan);
    state.planApproval = "approved";
    state.plannerPlan = { ...plan, status: "approved", approval: { sessionId: opts.sessionId, planId: plan.planId, version: plan.version, path: plan.path, digest: plan.digest } };
    if (opts.activePlan?.path !== plan.path) {
      opts.activeTasks = undefined;
      opts.currentTaskId = null;
      opts.taskRunState = null;
      state.taskRunState = null;
    }
    opts.activePlan = { path: plan.path, content: state.approvedAgentPlan };
    opts.userMessage = state.approvedAgentPlan;
  } catch (error) {
    failPlan(ctx, error);
  }
}


export async function runAgentPlanner(ctx: Omit<StageHandlerContext, "node">, call: ToolCall): Promise<void> {
  const { opts, state } = ctx;
  if (opts.mode !== "agent") return;
  if (state.planApproval === "approved" && state.approvedAgentPlan?.trim()) return;
  if (!state.plannerPlan && !needsAgentPlanApproval(opts, state.planRequested)) return;
  if (opts.signal?.aborted) {
    state.aborted = true;
    return;
  }
  let report: string;
  try {
    if (call.type !== "function" || call.function.name !== "dispatch_agent") throw new Error("只允许 dispatch_agent 工具调用");
    const args = JSON.parse(call.function.arguments) as Record<string, unknown>;
    if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("无效工具参数");
    // 任务分解阶段只允许计划子代理（Planner）；Explore 等其他类型直接拒绝，
    // 避免把只读调研结果当作计划交付。
    if (args.agent_type !== PLANNER_SUBAGENT_TYPE) {
      throw new Error(`任务分解阶段只允许调用计划子代理（agent_type="${PLANNER_SUBAGENT_TYPE}"），不允许调用 "${String(args.agent_type)}"`);
    }
    if (typeof args.task !== "string" || !args.task.trim()) throw new Error("缺少计划任务");
    const result = await executeTool({
      ...ctx.toolCtx,
      dispatchSubagent: ctx.toolCtx.dispatchSubagent
        ? (request) => ctx.toolCtx.dispatchSubagent!({
            ...request,
            relevantHistory: state.rawDecompose?.relevantHistory,
          })
        : undefined,
    }, {
      id: call.id, name: call.function.name, arguments: args, rawArguments: call.function.arguments,
    });
    if (!result.ok) throw new Error(result.output);
    report = result.output;
  } catch (error) {
    if (opts.signal?.aborted) {
      state.aborted = true;
      return;
    }
    state.planApproval = "unavailable";
    state.blocked = true;
    state.blockedReason = `只读 Planner 失败，执行已暂停：${error instanceof Error ? error.message : String(error)}`;
    return;
  }
  if (opts.signal?.aborted) {
    state.aborted = true;
    return;
  }
  if (report.startsWith("[Explore partial result") || report.startsWith("[Planner partial result")) {
    const detail = /^\[(?:Planner|Explore) partial result:[^\]]*\]/.exec(report.trim())?.[0] ?? "";
    state.planApproval = "unavailable";
    state.blocked = true;
    state.blockedReason = `只读 Planner 未完成计划，执行已暂停${detail ? `（${detail.slice(1, -1)}）` : ""}`;
    return;
  }
  const reportText = report.trim();
  const content = !reportText || /^## Final Report$/i.test(reportText)
    ? "Planner 未提供计划正文；批准后将按原任务要求继续。"
    : reportText;
  // 提前补上标题，避免写入器自动加标题后与保存时的摘要、回读校验不一致。
  const plan = content.startsWith("#") ? content : `## Final Report\n\n${content}`;
  await requestAgentPlanApproval(ctx, plan);
}
