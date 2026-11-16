import type { StageHandlerContext } from "./types.ts";
import type { AgentLoopOpts } from "../types.ts";
import { executeTool } from "../../execute.ts";
import type { ToolCall } from "@owncoder/llm";
import { PLANNER_SUBAGENT_TYPE } from "../../subagent/planner-subagent.ts";
import { approvePlannerPlan, readPlannerPlan, revisePlannerPlan, savePlannerPlan, validatePlannerPlan, type PlannerPlan } from "../../../plans.ts";

type PlanContext = Pick<StageHandlerContext, "opts" | "state" | "history">;

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
    ctx.opts.mode === "spec"
      ? "请查看计划后批准；仅授权只读设计，不授权源码实施。本轮到此结束。"
      : "请打开计划查看；下一轮明确批准执行或提出修改意见。本轮未实施计划内容。",
  ].join("\n\n") + `\n\n<!--plan_saved:${plan.path}-->`;
  ctx.history.push({ role: "assistant", content: ctx.state.lastAssistant });
  ctx.opts.onEvent?.({ type: "assistant_delta", text: ctx.state.lastAssistant });
}

export async function requestAgentPlanApproval(ctx: PlanContext, planText: string): Promise<void> {
  const { opts, state } = ctx;
  if (opts.signal?.aborted) {
    state.aborted = true;
    return;
  }
  try {
    if (opts.mode !== "agent" && opts.mode !== "spec") throw new Error("当前模式不支持计划审批");
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
  return (opts.mode === "agent" || opts.mode === "spec") && !opts.activePlan && requested === true;
}

/** 即使流水线省略任务分解，也在进入工具循环前重新校验磁盘版本和批准。 */
export async function requireAgentPlanApproval(ctx: Pick<StageHandlerContext, "opts" | "state">): Promise<boolean> {
  try {
    const current = await readPlannerPlan(ctx.opts.workspaceRoot, ctx.opts.sessionId);
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
      "只读修改下列完整计划，融合用户修改要求，返回完整新版而非增量。保留 ## Final Report、目标、编号步骤、相关文件与证据、风险与不确定性、验证方式。不得实施计划。",
      `当前计划 v${plan.version}：\n${content}`, `用户修改要求：\n${feedback}`,
    ].join("\n\n") }) },
  });
}

/** 从既有计划目录恢复；计划生成轮不调用此处的审批分支。 */
export async function resumeAgentPlan(ctx: Omit<StageHandlerContext, "node">): Promise<void> {
  const { opts, state } = ctx;
  if (opts.leanPipeline || opts.readOnly || (opts.mode !== "agent" && opts.mode !== "spec")) return;
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
    const approve = /^(?:approve|approved|批准(?:执行|计划)?|同意(?:执行|计划)?|实施|继续|开始执行|按计划执行|执行计划)[。！!\s]*$/i.test(input);
    const revision = /修改|调整|补充|纠正|更正|改成|改为|增加|删除|修订|revise|change|update/i.test(input);
    if (revision) {
      await generatePlanRevision(ctx, plan, content, input);
      return;
    }
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
        deliverPlan(ctx, plan, content);
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
      question: `${opts.mode === "spec" ? "仅批准只读设计，不修改源代码" : "批准后进入代码实施"}：${plan.path}（v${plan.version}，摘要 ${plan.digest}）。`,
      options: [
        { label: opts.mode === "spec" ? "批准计划" : "批准执行", value: token },
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
    opts.userMessage = opts.mode === "spec"
      ? plan.originalRequest ?? "按已批准的只读计划继续设计，文档仍需另行批准，不实施源码变更"
      : state.approvedAgentPlan;
  } catch (error) {
    failPlan(ctx, error);
  }
}

const PLANNER_SECTIONS = [
  { label: "目标", aliases: ["目标", "goal", "goals", "objective"] },
  { label: "步骤", aliases: ["步骤", "steps", "step"] },
  { label: "相关文件", aliases: ["相关文件", "related files", "files", "file"] },
  { label: "风险与不确定性", aliases: ["风险与不确定性", "风险", "risks and uncertainties", "risks", "risk", "uncertainties"] },
  { label: "验证方式", aliases: ["验证方式", "验证", "verification", "validation", "verify", "how to verify"] },
] as const;

/** Final Report 总标题：任意标题层级、大小写不敏感、允许短后缀。 */
const FINAL_REPORT_HEADING = /^#{1,6}[ \t]*(?:\d+[.)、．][ \t]*)?final[ \t]+report\b.*$/i;
/** 识别常见 Markdown 列表与中文序号，不把代码围栏里的示例当作步骤。 */
const NUMBERED_STEP = /^[ \t]*(?:#{1,6}[ \t]+)?(?:[-*+][ \t]+)?(?:[（(]\d+[)）]|\d+[.)、．:：）])[ \t]*\S/;

interface HeadingInfo {
  level: number;
  text: string;
}

/** 解析一行 Markdown 标题（#~###### 任意层级）或加粗伪标题（**目标**）。 */
function parseHeading(line: string): HeadingInfo | null {
  const trimmed = line.trim();
  const md = /^(#{1,6})[ \t]*(.+?)[ \t]*$/.exec(trimmed);
  if (md) return { level: md[1].length, text: md[2].replace(/[ \t]+#+[ \t]*$/, "").trim() };
  const bold = /^\*\*(.+?)\*\*[ \t]*$/.exec(trimmed);
  if (bold) return { level: 3, text: bold[1].trim() };
  return null;
}

/** 标题文本命中别名：允许编号前缀（“## 1. 目标”）与别名前缀（“## 相关文件与证据”）。 */
function headingMatches(text: string, aliases: readonly string[]): boolean {
  const stripped = text.replace(/^(?:[（(]?\d+[.)、．）])[ \t]*/, "").replace(/^\*\*(.*?)\*\*$/, "$1").trim().toLowerCase();
  return aliases.some((alias) => {
    const name = alias.toLowerCase();
    return stripped === name || stripped.startsWith(`${name}:`) || stripped.startsWith(`${name}：`)
      || (stripped.startsWith(`${name} `) && /^(?:and |with |— |– |- )/.test(stripped.slice(name.length + 1)))
      || (/[^a-z]$/i.test(name) && (stripped.startsWith(`${name}与`) || stripped.startsWith(`${name}（`)));
  });
}

function normalizePlannerReport(report: string): { body: string; hasFinalReportHeading: boolean } {
  const trimmed = report.trim();
  const lines = trimmed.split(/\r?\n/);
  let inFence = false;
  const index = lines.findIndex((line) => {
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; return false; }
    return !inFence && FINAL_REPORT_HEADING.test(line.trim());
  });
  return index >= 0
    ? { body: lines.slice(index).join("\n").trim(), hasFinalReportHeading: true }
    : { body: trimmed, hasFinalReportHeading: false };
}

function sectionContent(report: string, aliases: readonly string[]): string {
  const lines = report.split(/\r?\n/);
  let inFence = false;
  let start = -1;
  let startLevel = 0;
  for (let index = 0; index < lines.length; index++) {
    // 代码围栏内的 # 注释与 ** 强调不是标题，跳过以免截断章节内容。
    if (/^\s*(```|~~~)/.test(lines[index])) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const heading = parseHeading(lines[index]);
    if (!heading) continue;
    if (start < 0) {
      if (headingMatches(heading.text, aliases)) {
        start = index;
        startLevel = heading.level;
      }
      continue;
    }
    // 章节在下一个不深于起始标题的标题处结束；更深层级视为章节内小节。
    if (heading.level <= startLevel || PLANNER_SECTIONS.some(({ aliases: names }) => headingMatches(heading.text, names))) {
      return lines.slice(start + 1, index).join("\n").trim();
    }
  }
  return start < 0 ? "" : lines.slice(start + 1).join("\n").trim();
}

function meaningfulSectionLines(content: string): string[] {
  let inFence = false;
  return content.split(/\r?\n/).filter((line) => {
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; return false; }
    return !inFence && !!line.trim() && !parseHeading(line);
  });
}

export function validatePlannerReport(report: string): { normalized: string; missing: string[] } {
  const { body, hasFinalReportHeading } = normalizePlannerReport(report);
  const missing = PLANNER_SECTIONS
    .filter(({ aliases }) => meaningfulSectionLines(sectionContent(body, aliases)).length === 0)
    .map(({ label }) => label);
  const steps = meaningfulSectionLines(sectionContent(body, ["步骤", "steps", "step"]));
  if (steps.length > 0 && !steps.some((line) => NUMBERED_STEP.test(line))) missing.push("编号步骤");
  if (hasFinalReportHeading || missing.length > 0) {
    return { normalized: body, missing: hasFinalReportHeading ? missing : ["## Final Report", ...missing] };
  }
  // 五段齐全但缺少 Final Report 总标题：补齐结构标题，不因纯格式差异暂停。
  return { normalized: `## Final Report\n\n${body}`, missing: [] };
}

export async function runAgentPlanner(ctx: Omit<StageHandlerContext, "node">, call: ToolCall): Promise<void> {
  const { opts, state } = ctx;
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
    // 避免误调度只读调研代理导致计划结构校验失败后暂停执行。
    if (args.agent_type !== PLANNER_SUBAGENT_TYPE) {
      throw new Error(`任务分解阶段只允许调用计划子代理（agent_type="${PLANNER_SUBAGENT_TYPE}"），不允许调用 "${String(args.agent_type)}"`);
    }
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
  if (report.startsWith("[Explore partial result") || report.startsWith("[Planner partial result")) {
    const detail = /^\[(?:Planner|Explore) partial result:[^\]]*\]/.exec(report.trim())?.[0] ?? "";
    state.planApproval = "unavailable";
    state.blocked = true;
    state.blockedReason = `只读 Planner 未完成计划，执行已暂停${detail ? `（${detail.slice(1, -1)}）` : ""}`;
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
}
