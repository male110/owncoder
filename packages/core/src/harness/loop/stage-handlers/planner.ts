import type { StageHandlerContext } from "./types.ts";
import type { AgentLoopOpts } from "../types.ts";
import { executeTool } from "../../execute.ts";
import type { ToolCall } from "@owncoder/llm";
export async function requestAgentPlanApproval(
  ctx: StageHandlerContext,
  planText: string,
): Promise<void> {
  const { opts, state } = ctx;
  if (opts.signal?.aborted) {
    state.aborted = true;
    return;
  }
  if (!opts.askUser) {
    state.planApproval = "unavailable";
    state.blocked = true;
    state.blockedReason = "复杂 Agent 任务需要计划确认，但当前宿主未提供用户确认通道";
    return;
  }

  let answer: string;
  try {
    answer = await opts.askUser({
      question: `Agent 将根据以下计划分解任务并执行：\n\n${planText}\n\n请选择“批准执行”，或提出修改意见。`,
      options: [
        { label: "批准执行", value: "approve", description: "确认计划后开始执行工具和代码变更" },
        { label: "拒绝计划", value: "reject", description: "停止本轮执行，返回修改方向" },
      ],
      allowFreeText: true,
      placeholder: "输入修改意见，提交后本轮暂停",
    });
  } catch (error) {
    state.planApproval = "unavailable";
    state.blocked = true;
    state.blockedReason = `无法完成 Agent 计划审批：${error instanceof Error ? error.message : String(error)}`;
    return;
  }
  if (opts.signal?.aborted) {
    state.aborted = true;
    return;
  }
  const normalized = answer.trim().toLowerCase();
  if (normalized === "approve" || normalized === "approved" || normalized === "批准执行") {
    state.planApproval = "approved";
    opts.onEvent?.({ type: "reasoning_step", stepType: "plan_approval", content: "用户已批准 Agent 计划，将完整计划交给任务分解" });
    return;
  }
  state.planApproval = normalized === "reject" || normalized === "rejected" || normalized === "拒绝计划"
    ? "rejected"
    : "needs_revision";
  state.planApprovalFeedback = answer.trim() || undefined;
  state.blocked = true;
  state.blockedReason = state.planApproval === "rejected"
    ? "用户拒绝了 Agent 计划，执行已暂停"
    : `用户要求修改 Agent 计划${answer.trim() ? `：${answer.trim()}` : ""}`;
  state.lastAssistant = ["已暂停执行，尚未调用任何执行工具。", state.blockedReason, "请修改需求后重新发送，或在确认计划后再次执行。"].join("\n\n");
  ctx.history.push({ role: "assistant", content: state.lastAssistant });
  opts.onEvent?.({ type: "assistant_delta", text: state.lastAssistant });
}

export function needsAgentPlanApproval(
  opts: Pick<AgentLoopOpts, "mode" | "activePlan">,
  requested: boolean | undefined,
): boolean {
  return opts.mode === "agent" && !opts.activePlan && requested === true;
}

/**
 * Enforce the approval invariant at the writable ReAct boundary. The planner
 * stage is normally reached through task_decompose, but a persisted or
 * malformed pipeline must not be able to remove that prerequisite.
 */
export function requireAgentPlanApproval(ctx: Pick<StageHandlerContext, "opts" | "state">): boolean {
  if (!needsAgentPlanApproval(ctx.opts, ctx.state.planRequested)) return true;
  if (ctx.state.planApproval === "approved" && ctx.state.approvedAgentPlan?.trim()) return true;

  if (ctx.state.planApproval === null || ctx.state.planApproval === undefined) {
    ctx.state.planApproval = "unavailable";
  }
  ctx.state.blocked = true;
  ctx.state.blockedReason ??= "复杂 Agent 任务未完成有效计划审批，执行已暂停";
  return false;
}

const PLANNER_SECTIONS = [
  { label: "目标", aliases: ["目标"] },
  { label: "步骤", aliases: ["步骤"] },
  { label: "相关文件", aliases: ["相关文件", "文件"] },
  { label: "风险与不确定性", aliases: ["风险与不确定性", "风险"] },
  { label: "验证方式", aliases: ["验证方式", "验证"] },
] as const;

function normalizePlannerReport(report: string): string {
  const trimmed = report.trim();
  const reportStart = trimmed.indexOf("## Final Report");
  return reportStart >= 0 ? trimmed.slice(reportStart).trim() : trimmed;
}

function sectionContent(report: string, aliases: readonly string[]): string {
  const lines = report.split(/\r?\n/);
  const heading = new RegExp(`^#{2,6}[ \\t]*(?:${aliases.join("|")})[ \\t]*$`);
  const start = lines.findIndex((line) => heading.test(line.trim()));
  if (start < 0) return "";
  const end = lines.slice(start + 1).findIndex((line) => /^#{2,6}[ \\t]+\S/.test(line.trim()));
  return lines.slice(start + 1, end < 0 ? lines.length : start + 1 + end).join("\n").trim();
}

export function validatePlannerReport(report: string): { normalized: string; missing: string[] } {
  const normalized = normalizePlannerReport(report);
  const missing = normalized.startsWith("## Final Report")
    ? PLANNER_SECTIONS
        .filter(({ aliases }) => !sectionContent(normalized, aliases))
        .map(({ label }) => label)
    : ["## Final Report", ...PLANNER_SECTIONS.map(({ label }) => label)];
  if (!/^\s*\d+[.)]\s+\S/m.test(sectionContent(normalized, ["步骤"]))) missing.push("编号步骤");
  return { normalized, missing };
}

export async function runAgentPlanner(ctx: StageHandlerContext, call: ToolCall): Promise<void> {
  const { opts, state } = ctx;
  if (state.planApproval === "approved" && state.approvedAgentPlan?.trim()) return;
  if (!needsAgentPlanApproval(opts, state.planRequested)) return;
  if (opts.signal?.aborted) {
    state.aborted = true;
    return;
  }
  let report: string;
  try {
    if (call.type !== "function" || call.function.name !== "dispatch_agent") throw new Error("只允许 dispatch_agent 工具调用");
    const args = JSON.parse(call.function.arguments) as Record<string, unknown>;
    if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("无效工具参数");
    if (args.agent_type !== undefined && args.agent_type !== "Explore") throw new Error("只允许 Explore 子代理");
    if (typeof args.task !== "string" || !args.task.trim()) throw new Error("缺少计划任务");
    if (args.thoroughness !== undefined && args.thoroughness !== "medium" && args.thoroughness !== "very thorough") throw new Error("无效搜索广度");
    const result = await executeTool(ctx.toolCtx, {
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
  if (report.startsWith("[Explore partial result")) {
    state.planApproval = "unavailable";
    state.blocked = true;
    state.blockedReason = "只读 Planner 未完成计划，执行已暂停";
    return;
  }
  const validation = validatePlannerReport(report);
  if (validation.missing.length > 0) {
    state.planApproval = "unavailable";
    state.blocked = true;
    state.blockedReason = `只读 Planner 未返回包含目标、步骤、文件、风险和验证方式的有效计划，缺少：${validation.missing.join("、")}，执行已暂停`;
    opts.onEvent?.({
      type: "warning",
      message: state.blockedReason,
    });
    return;
  }

  await requestAgentPlanApproval(ctx, validation.normalized);
  if (state.planApproval === "approved") state.approvedAgentPlan = validation.normalized;
}
