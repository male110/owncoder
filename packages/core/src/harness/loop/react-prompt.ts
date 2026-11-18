/**
 * ReAct 提示词构造与工具结果历史摘要。
 *
 * 从 react.ts 拆分：当前任务/本轮任务上下文格式化、打包历史、
 * 工具结果的历史摘要、文档交付物检测等纯函数。
 * 本模块为纯函数模块，不依赖 react.ts。
 */
import { type TaskItem } from "../../plans.ts";
import type { ChatTurn } from "./types.ts";
import type { ToolResultMetadata } from "../tools/types.ts";
import { USER_FACING_WRITE_TOOLS } from "./react-steps.ts";
import { SPEC_TASK_OUTCOME_TOOL } from "./single-spec-task.ts";

const SPEC_DOC_LABEL: Record<string, string> = {
  save_spec: "Requirements spec",
  save_design: "Technical design",
  save_tasks: "Implementation task list",
};

/**
 * Synthesize a one-line user-visible summary from a file-modifying tool's result.
 * Only generated on success; returns null when no summary is needed (read-only tools or failures).
 */
export function summarizeToolActionForUser(
  name: string,
  result: { ok: boolean; output: string },
): string | null {
  if (!result.ok || !USER_FACING_WRITE_TOOLS.has(name)) return null;
  const out = result.output ?? "";
  if (name === "save_spec" || name === "save_design" || name === "save_tasks") {
    const label = SPEC_DOC_LABEL[name] ?? "Document";
    const p = out.replace(/^(?:Spec|Design|Tasks) saved to\s*/i, "").replace(/\.\n[\s\S]*$/s, "").trim();
    const link = p ? `[${p}](${p})` : "";
    const next = name === "save_design"
      ? '请查看设计文档。看完后，用自己的话告诉我想继续生成任务，还是调整设计。'
      : name === "save_tasks"
        ? "请查看任务清单。准备好后，在预览中点击任务旁的「执行」或顶部的「全部执行」。"
        : "请查看需求文档。看完后，用自己的话告诉我想继续生成设计，还是调整需求。";
    return `${label} saved${link ? `: ${link}` : ""}. ${next}`;
  }
  if (name === "write_file") {
    const p = out.replace(/^Wrote\s*/i, "").replace(/\s*\([^)]*\)\s*$/, "").trim();
    return `File written${p ? `: ${p}` : ""}.`;
  }
  if (name === "apply_patch") {
    const p = out.replace(/^Patched\s*/i, "").replace(/\s*\([^)]*\)\s*$/, "").trim();
    return `File patched${p ? `: ${p}` : ""}.`;
  }
  return null;
}

/**
 * 每轮注入给模型的迭代预算提示（current 从 1 开始，与 termination 的
 * `state.iteration >= maxIterations` 判定同源）。
 *
 * 剩余 0 表示本次迭代结束后循环即达上限：此时不再给工具调用引导，而是
 * 注入强制性收尾指令——本轮不得再调用工具，必须直接输出最终计划/结论文本，
 * 避免模型把最后一轮也花在工具调用上、随后被上限截断成 partial
 * result。措辞不重复 react.ts 终态用的“已达到最大迭代限制”，避免两处
 * 文案互相矛盾。
 *
 * planner 模式（Planner 子代理循环）预算小且必须收口：常规轮引导高效调研
 * 并提示 submit_plan 出口；进入收尾区（剩余 ≤ PLANNER_WRAP_UP_TURNS）后
 * 注入递进压力——停止调研、基于已有证据写计划、立即提交——而不是
 * “剩余 N 次请自行安排”这种对只读规划循环反向鼓励继续调工具的措辞。
 *
 * explore 模式（Explore 子代理循环）同构：submit_report 出口 + 收尾区
 * 递进收口压力（未确认缺口显式写为 gap，而不是继续搜索）。
 */
export const PLANNER_WRAP_UP_TURNS = 6;

/** Explore 子代理收尾区阈值：剩余迭代少于该值即开始递进收口压力。 */
export const EXPLORE_WRAP_UP_TURNS = 6;

export function formatIterationBudgetHint(
  current: number,
  max: number,
  mode: "executor" | "planner" | "explore" | "single_spec_task" = "executor",
): string {
  const remaining = Math.max(0, max - current);
  if (remaining === 0 && mode === "single_spec_task") {
    return `Final iteration. Call ${SPEC_TASK_OUTCOME_TOOL} or report_blocker now. Do not make any other tool calls.`;
  }
  if (remaining === 0) {
    return `当前第 ${current} 次迭代，上限 ${max} 次，剩余 0 次。这是最后一次迭代：本轮不得再调用任何工具，必须直接输出最终计划/结论文本（含已完成工作、证据与剩余风险），不要再发起工具调用。`;
  }
  if (mode === "planner") {
    const tail = remaining <= PLANNER_WRAP_UP_TURNS
      ? `仅剩 ${remaining} 次迭代。停止进一步调研：基于已收集的证据撰写完整计划（目标/编号步骤/相关文件/风险与不确定性/验证方式五段），并立即调用 submit_plan 提交；无法确认的点直接写入风险与不确定性。`
      : `请高效调研：只读计划必需的证据，证据足够后立即调用 submit_plan 提交完整计划，不要继续验证性读取。`;
    return `当前第 ${current} 次迭代，上限 ${max} 次，剩余 ${remaining} 次。${tail}`;
  }
  if (mode === "explore") {
    const tail = remaining <= EXPLORE_WRAP_UP_TURNS
      ? `仅剩 ${remaining} 次迭代。停止进一步调研：基于已有发现撰写调研总结（已确认发现 + 文件路径与行号 + 未确认缺口），并立即调用 submit_report 提交；找不到的点显式写为未确认，不要继续搜索。`
      : `请高效调研：只回答调研问题必需的证据，问题已明确后立即调用 submit_report 提交调研总结，不要继续验证性读取。`;
    return `当前第 ${current} 次迭代，上限 ${max} 次，剩余 ${remaining} 次。${tail}`;
  }
  return `当前第 ${current} 次迭代，上限 ${max} 次，剩余 ${remaining} 次。请据此安排工具调用预算，优先完成核心改动与验证。`;
}

function formatPackedHistory(task: TaskItem): string {
  const text = task.relevantHistory?.trim() ?? "";
  return text
    ? `### Reusable history (from task decomposition)\nReview and reuse this history before acting. If it already provides clear, relevant, sufficient file paths, symbols, code locations, call chains, or conclusions for the task, do not search for or re-explore them; continue from that information. Only perform the smallest necessary check when information is missing, conflicting, or potentially outdated, focusing on the uncertain part. Treat history as a lead, not verified fact, and cite actual evidence in the result.\n${text}`
    : "";
}

export function formatTaskConstraints(task: TaskItem): string {
  return task.userConstraints?.length
    ? `### Task constraints\n${task.userConstraints.map((constraint) => `- ${constraint}`).join("\n")}`
    : "";
}




export function formatCurrentTaskContext(task: TaskItem, singleSpecTask = false): string {
  // Keep this contract short and mechanical. The model needs an explicit stop
  // condition, while detailed exploration prose belongs in the base prompt.
  return [
    singleSpecTask
      ? "## Current Task (only the selected Spec task is authorized)"
      : "## **Current Task (in progress; prioritize; move to the next only after completion)**",
    "Execution discipline (mandatory):",
    "- If the task names an exact file/range or replacement text, read only that target, then edit and verify; do not inspect anything else.",
    "- You have no search tools: any fact not already established (file location, symbol, call chain, external doc) must come from a dispatch_agent (Explore) report. read_file is only for paths already established by the task, plan, a prior Explore report, or your own edits.",
    "- Reuse fresh evidence already in context; do not re-read an unchanged file or dispatch a second Explore to re-verify what an earlier report established.",
    "- A line range already read in this session is fresh evidence: analyze from it instead of re-reading; when a plan or Explore report already gives a line range, read that range directly in one call.",
    "- Before dispatch_agent with agent_type=\"Explore\", write a self-contained exploration brief from the current request, task guidance, reusable history, and evidence already gathered: the concrete deliverable or decision, confirmed file paths and classes/methods/fields or line ranges, conclusions and their evidence, the specific unknowns to resolve, preferred entry points, the limited call chains to trace, areas and anchors that must not be read or explored again, relevant boundaries and failure paths, and the file paths, symbols, and line ranges the Explore report must return. If only a module-level entry is known, name that module and the symbols to locate and why; if no repository evidence exists, describe the behavior to find and the most likely layer without guessing paths or method names. Never send only broad requests such as \"explore the relevant code\", \"find the implementation\", or \"investigate further\", and never ask Explore to relocate anchors already confirmed in history.",
    "- When the evidence is sufficient, stop dispatching explorations immediately and edit, verify, report, or state the blocker.",
    `ID: ${task.id}`,
    `Execution guidance (how to carry out this task): ${task.executionGuidance}`,
    task.dependsOn.length > 0 ? `Depends on: ${task.dependsOn.join(", ")}` : "",
    task.acceptance ? `Acceptance criteria: ${task.acceptance}` : "",
    task.progressStatus ? `Progress status: ${task.progressStatus}` : "",
    formatTaskConstraints(task),
    formatPackedHistory(task),
    singleSpecTask
      ? `Do not execute another task or change the plan/task list. After doing the work and checking acceptance, call ${SPEC_TASK_OUTCOME_TOOL} with completed or failed and the result. If user action is needed, call report_blocker. Plain text cannot complete the task.`
      : "Use tools to execute this task. When done, stop calling tools and report the result concisely.",
    "Final response format (unless the user explicitly requests a different format):",
    "- For multi-point analysis or reports, use Markdown headings (## / ###), short paragraphs separated by blank lines, and bullet or numbered lists for distinct findings, evidence, changes, and verification results as applicable.",
    "- Put code, SQL, configuration, or multi-line commands in fenced code blocks with a language tag when needed; keep identifiers and file paths in inline code.",
    "- Preserve the business conclusions, supporting evidence, and uncertainty; brevity must not collapse them into one sentence, a semicolon-separated wall of text, or a single dense paragraph. Simple answers may stay brief without extra sections.",
  ].filter(Boolean).join("\n");
}

function isSourceReadTool(
  call: { name: string },
  result: { ok: boolean; metadata?: ToolResultMetadata },
): boolean {
  return result.ok && (
    result.metadata?.kind === "read_file" ||
    call.name === "read_symbol" ||
    call.name === "read_outline"
  );
}

export function summarizeToolResultForHistory(
  call: { name: string; arguments?: Record<string, unknown> },
  result: { ok: boolean; output: string; metadata?: ToolResultMetadata },
): string {
  const output = result.output;
  if (isSourceReadTool(call, result)) {
    if (result.metadata?.kind === "read_file") {
      const path = result.metadata.path;
      const start = result.metadata.startLine ?? "?";
      const end = result.metadata.endLine ?? "?";
      const total = result.metadata.totalLines ?? "?";
      return `Read ${path} (lines ${start}-${end} of ${total})\n${output}`;
    }
    const path = String(call.arguments?.path ?? "").trim();
    return path ? `${call.name} ${path}\n${output}` : output;
  }
  if (!result.ok) return `${call.name} failed: ${output}`;
  return `${call.name} completed: ${output}`;
}

/** 从 history 末尾找最近一条非空 assistant 文本（用于空响应时回填 lastAssistant）。 */
export function lastAssistantSummaryFromHistory(history: ChatTurn[]): string | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i]!;
    if (h.role === "assistant" && h.content.trim()) return h.content;
  }
  return null;
}
