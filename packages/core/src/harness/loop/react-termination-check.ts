/**
 * ReAct 循环的迭代终止检查。
 *
 * 从 react.ts 拆分：原 runReActLoop 每轮迭代开头的 checkTermination 调用，
 * 含正常收敛识别（exploration-skip / 连续相似输出不得表现为错误）、
 * 开发环境遥测、终止事件日志与 history 补写。
 * 返回 null 表示继续循环，否则返回终态结果。
 */
import { writeEventLog } from "@owncoder/llm";
import { logReasoningStep } from "../agent-reasoning.ts";
import { checkTermination } from "./termination.ts";
import { getGlobalMetricsCollector } from "./termination-metrics.ts";
import { finalizeSuccess, finalizeTerminal } from "./react-finalize.ts";
import { forcedFinalReport } from "./react-forced-report.ts";
import type { ReActLoopContext, ReActReturn } from "./react-loop-context.ts";

/** 迭代开始时检查终止条件；首轮（i === 0）跳过。 */
export async function handleTerminationCheck(ctx: ReActLoopContext, i: number): Promise<ReActReturn | null> {
  if (i <= 0) return null;
  const terminationResult = checkTermination(ctx.loopState, ctx.terminationConfig);
  if (!terminationResult.shouldTerminate) return null;
  // Normal convergence (exploration-skip / consecutive similar outputs):
  // must never surface as "出错了 / Task may be incomplete".
  const normalConverged =
    terminationResult.metadata != null &&
    typeof terminationResult.metadata === "object" &&
    terminationResult.metadata.normalCompletion === true;
  const aborted = Boolean(terminationResult.aborted) && !normalConverged;

  writeEventLog({
    category: "react_loop",
    message: `ReAct loop terminated: ${terminationResult.reason}`,
    details: {
      stageId: ctx.stageId,
      iteration: i,
      reason: terminationResult.reason,
      aborted,
      metadata: terminationResult.metadata,
    },
  });

  logReasoningStep(ctx.reasoningTrace, {
    type: "observation",
    content: `Loop terminated: ${terminationResult.reason}`,
    timestamp: Date.now(),
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Telemetry: 收集终止指标（仅开发环境）
  // ═══════════════════════════════════════════════════════════════════════════
  const isDev = process.env.NODE_ENV === "development" || process.env.OWNCODER_DEV === "true";

  if (isDev) {
    const metricsPayload = {
      type: "loop_termination_metrics" as const,
      terminationReason: terminationResult.reason,
      isAborted: aborted,
      iterations: i,
      totalToolCalls: ctx.loopState.totalToolCalls,
      consecutiveSimilarOutputs: ctx.loopState.consecutiveSimilarOutputs,
      consecutiveTextOnlyTurns: ctx.loopState.consecutiveTextOnlyTurns,
      metadata: terminationResult.metadata,
    };

    // 发送遥测事件
    ctx.opts.onEvent?.(metricsPayload);

    // 记录到全局收集器
    getGlobalMetricsCollector().record({
      timestamp: Date.now(),
      sessionId: ctx.stageId,
      terminationReason: terminationResult.reason,
      isAborted: aborted,
      iterations: i,
      totalToolCalls: ctx.loopState.totalToolCalls,
      consecutiveSimilarOutputs: ctx.loopState.consecutiveSimilarOutputs,
      consecutiveTextOnlyTurns: ctx.loopState.consecutiveTextOnlyTurns,
      metadata: terminationResult.metadata,
    });
  }

  let finalResponse = terminationResult.lastAssistant || ctx.lastAssistant;

  // 硬限制（迭代/工具调用/成本上限）且无任何文本：做一次无工具强制总结，
  // 保证父智能体拿到已收集的发现。中止（aborted）路径不强行总结。
  if (
    ctx.opts.forcedFinalReportOnLimit &&
    terminationResult.limitReached &&
    !finalResponse.trim()
  ) {
    finalResponse = await forcedFinalReport(ctx, terminationResult.reason);
  }

  // 根据终止原因设置不同的事件类型
  if (aborted) {
    ctx.opts.onEvent?.({
      type: "error",
      message: `Task may be incomplete: ${terminationResult.reason}`,
    });
  } else if (terminationResult.limitReached) {
    // 达到硬限制（迭代/工具调用/token/成本上限）而停止，非异常终止：
    // 任务可能未完成，向用户显示提示而非静默停止。
    ctx.opts.onEvent?.({
      type: "warning",
      message: `已达到${terminationResult.reason}，任务可能尚未完成。可在流水线设置中调高对应上限后重试。`,
    });
  }

  // 工具轮次不把模型文本推进 history。终止时若末条还不是这份报告，补写一次。
  // 相似输出终止时末条通常已是上一份近重复报告，不要再叠第二条。
  if (finalResponse.trim()) {
    const lastHist = ctx.history[ctx.history.length - 1];
    const lastIsSameReport =
      lastHist?.role === "assistant" && lastHist.content === finalResponse;
    const lastIsSimilarReport =
      ctx.loopState.consecutiveSimilarOutputs >= 1 &&
      lastHist?.role === "assistant" &&
      Boolean(lastHist.content?.trim());
    if (!lastIsSameReport && !lastIsSimilarReport) {
      ctx.history.push({ role: "assistant", content: finalResponse });
    }
  }

  if (aborted) {
    return finalizeTerminal(ctx, {
      lastAssistant: finalResponse,
      aborted,
      correctionCount: ctx.correctionCount,
      documentWorkflow: ctx.documentWorkflowUpdate,
    }, "interrupted");
  }

  // 硬限制（迭代/工具调用/成本上限）不是成功：标记 blocked 并带上原因，
  // 由 loop 层透传给 Explore 父智能体；普通收敛仍按成功收尾。
  if (terminationResult.limitReached) {
    return finalizeTerminal(ctx, {
      lastAssistant: finalResponse,
      aborted: false,
      blocked: true,
      blockedReason: terminationResult.reason,
      correctionCount: ctx.correctionCount,
      documentWorkflow: ctx.documentWorkflowUpdate,
    }, "failed");
  }

  return finalizeSuccess(ctx, {
    lastAssistant: finalResponse,
    aborted,
    correctionCount: ctx.correctionCount,
    documentWorkflow: ctx.documentWorkflowUpdate,
  });
}
