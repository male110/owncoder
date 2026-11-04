/**
 * ReAct 循环的任务运行状态记账与终态封装。
 *
 * 从 react.ts 拆分：原 runReActLoop 内的任务运行状态事件发射、公开决策摘要
 * 记录、withRunState/finalizeSuccess/finalizeTerminal 终态封装，
 * 以及"task-driven 但无 pending tasks 直接收尾"的早退路径。
 */
import { writeEventLog } from "@owncoder/llm";
import {
  applyTaskEvent,
  finalizeTaskSuccess,
  taskRunMetricsSnapshot,
  taskRunPhaseLabel,
  taskRunTotalDurationMs,
} from "../../task-run.ts";
import { taskProgress, type TaskItem } from "../../plans.ts";
import { formatFinalTaskReports } from "./task-reports.ts";
import type { ReactDecisionSummary } from "./types.ts";
import type {
  FinalizeSuccessInput,
  FinalizeTerminalInput,
  ReActLoopContext,
  ReActReturn,
} from "./react-loop-context.ts";

/** 记录一条公开决策摘要（有界，不含私有思维链）。 */
export function recordDecision(ctx: ReActLoopContext, summary: ReactDecisionSummary): void {
  ctx.decisionSummaries.push(summary);
  ctx.opts.onEvent?.({ type: "decision_summary", summary });
}

/** 发射当前任务运行状态快照（UI 轮询用）。 */
function emitTaskRunState(ctx: ReActLoopContext): void {
  const taskRunState = ctx.taskRunState;
  if (!taskRunState) return;
  const metrics = taskRunMetricsSnapshot(taskRunState.metrics);
  ctx.opts.onEvent?.({
    type: "task_run_state",
    taskId: taskRunState.taskId,
    phase: taskRunState.phase,
    verificationStatus: taskRunState.verification.status,
    verificationPassed: taskRunState.verification.passed,
    verificationSummary: taskRunState.verification.summary,
    repairAttempts: taskRunState.repairAttempts,
    maxRepairAttempts: taskRunState.maxRepairAttempts,
    label: taskRunPhaseLabel(taskRunState.phase),
    metrics,
    totalDurationMs: taskRunTotalDurationMs(taskRunState.metrics),
  });
}

/** 应用任务运行事件并同步发射快照。 */
export function applyRunEvent(ctx: ReActLoopContext, event: Parameters<typeof applyTaskEvent>[1]): void {
  if (ctx.taskRunState) {
    ctx.taskRunState = applyTaskEvent(ctx.taskRunState, event);
    emitTaskRunState(ctx);
  }
}

/** 持久化当前任务进度（task-driven 模式）。 */
export async function persistTaskUpdate(ctx: ReActLoopContext, nextId: string | null): Promise<void> {
  if (ctx.opts.onTaskUpdate) await ctx.opts.onTaskUpdate(ctx.tasks, nextId);
}

/** 当前信息任务：agent 模式取 currentTask，否则取本轮临时 information task。 */
export function activeInformationTask(ctx: ReActLoopContext): TaskItem | null {
  return ctx.currentTask ?? ctx.turnInformationTask;
}

/** 把当前信息任务同步到终止系统的 loopState。 */
export function syncLoopTask(ctx: ReActLoopContext): void {
  ctx.loopState.currentTask = activeInformationTask(ctx) ?? undefined;
}

function withRunState(ctx: ReActLoopContext, result: Omit<ReActReturn, "taskRunState">): ReActReturn {
  // 如果自动修复耗尽，在最终报告末尾追加失败提示（不中断流程）。
  let out = { ...result, taskRunState: ctx.taskRunState, decisionSummaries: ctx.decisionSummaries };
  if (ctx.autoFixFailureSummary && out.lastAssistant) {
    out = { ...out, lastAssistant: `${out.lastAssistant}\n\n> ⚠️ ${ctx.autoFixFailureSummary}` };
  }
  return out;
}

/** 最终成功路径：必须通过 canReportSuccess / sealTaskRunSuccess 门禁。 */
export function finalizeSuccess(ctx: ReActLoopContext, result: FinalizeSuccessInput): ReActReturn {
  const originalAssistant = result.lastAssistant ?? "";
  const finalized = finalizeTaskSuccess({
    taskRunState: ctx.taskRunState,
    result,
    requiresVerification: ctx.hadFileModifyingTools || ctx.autoFixState.hasUnresolvedErrors,
  });
  ctx.taskRunState = finalized.taskRunState;
  if (ctx.taskRunState) emitTaskRunState(ctx);
  const out = finalized.result;
  // 门禁失败：短提示只进 LLM 正文（history + 流式 delta），不发 warning 顶部条。
  if (out.successRejected && out.lastAssistant && out.lastAssistant !== originalAssistant) {
    const last = ctx.history[ctx.history.length - 1];
    if (last?.role === "assistant") {
      last.content = out.lastAssistant;
    } else {
      ctx.history.push({ role: "assistant", content: out.lastAssistant });
    }
    const suffix = originalAssistant && out.lastAssistant.startsWith(originalAssistant)
      ? out.lastAssistant.slice(originalAssistant.length)
      : out.lastAssistant;
    if (suffix.trim()) {
      ctx.opts.onEvent?.({ type: "assistant_delta", text: suffix });
    }
  }
  return withRunState(ctx, out);
}

/** 非成功终止（中止/阻塞/交还）时同步 phase。 */
export function finalizeTerminal(
  ctx: ReActLoopContext,
  result: FinalizeTerminalInput,
  phase: "failed" | "blocked" | "interrupted",
): ReActReturn {
  if (ctx.taskRunState) {
    const reason =
      result.blockedReason?.trim() ||
      (phase === "interrupted"
        ? "interrupted"
        : phase === "blocked"
          ? "blocked"
          : "failed");
    applyRunEvent(ctx, {
      type: "phase_changed",
      taskId: ctx.opts.sessionId,
      phase,
      reason,
    });
  }
    return withRunState(ctx, result);
}

/** task-driven 但没有任何可执行 pending/in_progress 任务：直接收尾，不要再进 LLM 循环。 */
export async function exitNoPendingTasks(ctx: ReActLoopContext): Promise<ReActReturn> {
  await persistTaskUpdate(ctx, null);
  const { done, total } = taskProgress(ctx.tasks);
  const finalReport = formatFinalTaskReports(ctx.taskReports);
  if (finalReport.trim()) {
    ctx.history.push({ role: "assistant", content: finalReport });
    ctx.opts.onEvent?.({ type: "assistant_delta", text: finalReport });
  }
  writeEventLog({
    category: "react_loop",
    message: `ReAct loop 退出: 无 pending tasks (${done}/${total})，跳过循环`,
    details: { stageId: ctx.stageId, done, total, taskDriven: true },
  });
  return finalizeSuccess(ctx, {
    lastAssistant: finalReport,
    aborted: false,
    correctionCount: ctx.correctionCount,
    documentWorkflow: ctx.documentWorkflowUpdate,
  });
}
