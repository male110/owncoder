/**
 * ReAct 循环的纯文本响应分支。
 *
 * 从 react.ts 拆分：原 runReActLoop 内 `calls.length === 0` 的分支，
 * 含弱模型 nudge 注入（允许工具执行后的纯文本继续探索）、
 * 任务推进（task advance：报告保留、上下文隔离、状态切换）与最终文本退出。
 * 返回 continue 表示继续下一轮迭代，return 表示循环应终止。
 */
import { writeEventLog } from "@owncoder/llm";
import { logReasoningStep, selectNextStep } from "../agent-reasoning.ts";
import { selectNextPendingTask, taskProgress } from "../../plans.ts";
import { resetOutputTrackingForNewTask, updateStateAfterResponse } from "./termination.ts";
import { shouldInjectPostToolTextNudge } from "./continuation-intent.ts";
import { isExplorationComplete } from "./react-steps.ts";
import { formatFinalTaskReports, isolateMessagesForNextTask } from "./task-reports.ts";
import { lastAssistantSummaryFromHistory } from "./react-prompt.ts";
import {
  activeInformationTask,
  finalizeSuccess,
  persistTaskUpdate,
  syncLoopTask,
} from "./react-finalize.ts";
import type { NormalizedUsage } from "../observability.ts";
import type { ReActLoopContext, ReActReturn } from "./react-loop-context.ts";

/** 工具执行后纯文本 nudge 的最大注入次数（一旦消耗不回退）。 */
const maxPostToolTextNudges = 2;

export type TextBranchOutcome =
  | { kind: "continue" }
  | { kind: "return"; result: ReActReturn };

/** 无工具调用的纯文本响应：reflect 并结束，或按协议继续循环。 */
export async function handleTextResponse(
  ctx: ReActLoopContext,
  i: number,
  content: string,
  finishReason: string | null,
  responseUsage: NormalizedUsage,
): Promise<TextBranchOutcome> {
  // 弱模型容错：本轮为纯文本响应。先保留上一轮是否执行过工具的信息供 nudge
  // 判断，随即清除 flag——nudge 只给一次额外机会，连续两轮纯文本则尊重其结束意图。
  const toolsRanLastIter = ctx.prevIterHadToolCalls;
  ctx.prevIterHadToolCalls = false;
  // 文档已交付 → 直接返回等待用户确认
  if (!content.trim() && ctx.documentDelivered) {
    const fallback = ctx.lastAssistant || lastAssistantSummaryFromHistory(ctx.history) || `Document ${ctx.deliveredDocName} has been generated. Awaiting your confirmation before continuing.`;
    return {
      kind: "return",
      result: finalizeSuccess(ctx, { lastAssistant: fallback, aborted: false, awaitingUserConfirmation: true, correctionCount: ctx.correctionCount }),
    };
  }

  // ── Assistant-style: finish_reason as primary loop control signal ──
  // "length" → response was truncated by token limit; the model may have
  // been mid-generation (possibly mid tool-call). Force continuation so
  // the model can resume from where it left off.
  if (finishReason === "length") {
    logReasoningStep(ctx.reasoningTrace, {
      type: "observation",
      content: "Model response truncated (finish_reason=length), continuing loop",
      timestamp: Date.now(),
    });
    if (content.trim()) {
      updateStateAfterResponse(ctx.loopState, {
        content,
        toolCalls: [],
        finishReason,
        tokens: responseUsage.totalTokens,
        cost: (responseUsage.promptTokens / 1000) * 0.002 + (responseUsage.completionTokens / 1000) * 0.01,
      });
      ctx.history.push({ role: "assistant", content });
    }
    return { kind: "continue" };
  }

  // 弱模型：LLM 本轮只回纯文本（无 tool_calls）时，仅在探索未完成时 nudge（上限 maxPostToolTextNudges）。
  // 三条件：allowlist 小模型（loopNudgeEnabled）+ LLM 纯文本（本分支）+ 探索未完成。
  const nudgeInfoTask = activeInformationTask(ctx);
  const hasPendingExploration =
    !!nudgeInfoTask &&
    !isExplorationComplete(nudgeInfoTask);
  if (
    ctx.loopNudgeEnabled &&
    !ctx.taskDriven &&
    toolsRanLastIter &&
    hasPendingExploration &&
    content.trim() &&
    !ctx.documentDelivered &&
    !ctx.handoffRequested &&
    ctx.postToolTextNudgeCount < maxPostToolTextNudges &&
    shouldInjectPostToolTextNudge(content, false)
  ) {
    ctx.postToolTextNudgeCount++;
    writeEventLog({
      category: "react_loop",
      message: `ReAct loop: 工具执行后模型返回纯文本，注入 nudge 引导继续 (iteration ${i}, nudge ${ctx.postToolTextNudgeCount}/${maxPostToolTextNudges})`,
      details: {
        stageId: ctx.stageId,
        iteration: i,
        finishReason,
        content: content.slice(0, 200),
        explorationComplete: false,
        hasPendingExploration,
        postToolTextNudgeCount: ctx.postToolTextNudgeCount,
      },
    });
    logReasoningStep(ctx.reasoningTrace, {
      type: "observation",
      content: `Model returned text-only response after tool execution (finish_reason=${finishReason ?? "unknown"}, nudge ${ctx.postToolTextNudgeCount}/${maxPostToolTextNudges}), injecting nudge to encourage continuation`,
      timestamp: Date.now(),
    });
    updateStateAfterResponse(ctx.loopState, {
      content,
      toolCalls: [],
      finishReason: finishReason ?? "stop",
      tokens: responseUsage.totalTokens,
      cost: (responseUsage.promptTokens / 1000) * 0.002 + (responseUsage.completionTokens / 1000) * 0.01,
    });
    ctx.history.push({ role: "assistant", content });
    ctx.messages.push({
      role: "system",
      content:
        "You just executed a tool and described the result, but the task is not yet complete. " +
        "Continue the work: call the next tool needed to make progress (e.g. read another file, " +
        "apply an edit, run a check), or if the task is genuinely done, state your final conclusion clearly. " +
        "Do not stop after a single tool call unless the entire task is finished.",
    });
    return { kind: "continue" };
  }

  // ── Hard step-driver: model reported text ⇒ current task done/failed ⇒ advance ──
  if (ctx.taskDriven && ctx.currentTask && content.trim()) {
    updateStateAfterResponse(ctx.loopState, {
      content,
      toolCalls: [],
      finishReason: finishReason ?? "stop",
      tokens: responseUsage.totalTokens,
      cost: (responseUsage.promptTokens / 1000) * 0.002 + (responseUsage.completionTokens / 1000) * 0.01,
    });
    ctx.history.push({ role: "assistant", content });
    const failed = /incomplete|failed|unable|cannot|error|failed/i.test(content);
    ctx.currentTask.status = failed ? "failed" : "completed";
    // 保留完整任务报告，避免后续任务状态只拿到报告开头。
    ctx.currentTask.result = content;
    ctx.taskReports.push({
      taskId: ctx.currentTask.id,
      executionGuidance: ctx.currentTask.executionGuidance,
      status: ctx.currentTask.status,
      report: content,
    });
    logReasoningStep(ctx.reasoningTrace, {
      type: "observation",
      content: `Task ${ctx.currentTask.id} → ${ctx.currentTask.status}: ${ctx.currentTask.result}`,
      timestamp: Date.now(),
    });
    const justDone = ctx.currentTask;
    const next = selectNextPendingTask(ctx.tasks);
    ctx.currentTask = next;
    syncLoopTask(ctx);

    if (next) {
      // Previous task's similar-output / stop / text-only counters must not
      // terminate the next task on the following iteration's checkTermination.
      resetOutputTrackingForNewTask(ctx.loopState);
      // Isolate LLM context: drop previous task's assistant/tool turns so
      // the next task starts from the stable prefix only (no prior report).
      isolateMessagesForNextTask(ctx.messages, ctx.messagePrefixLen);
      ctx.postToolTextNudgeCount = 0;
      ctx.consecutiveReadonlyIters = 0;
      // 新任务的文件读取从零计：上一任务的预算不带入下一任务。
      ctx.sameFileReads.clear();
      ctx.prevIterHadToolCalls = false;
      next.status = "in_progress";
      await persistTaskUpdate(ctx, next.id);
      writeEventLog({
        category: "react_loop",
        message: `任务切换：已隔离上一任务 messages，开始 ${next.id}`,
        details: {
          stageId: ctx.stageId,
          iteration: i,
          completedTaskId: justDone.id,
          completedStatus: justDone.status,
          nextTaskId: next.id,
          messagePrefixLen: ctx.messagePrefixLen,
          messagesLen: ctx.messages.length,
          retainedReports: ctx.taskReports.length,
        },
      });
      return { kind: "continue" };
    }
    await persistTaskUpdate(ctx, null);
    const { done, total } = taskProgress(ctx.tasks);
    const finalReport = formatFinalTaskReports(ctx.taskReports);
    ctx.history.push({ role: "assistant", content: finalReport });
    ctx.opts.onEvent?.({ type: "assistant_delta", text: finalReport });
    writeEventLog({
      category: "react_loop",
      message: `ReAct loop 退出: 全部任务已处理 (${done}/${total})，iteration ${i}`,
      details: {
        stageId: ctx.stageId,
        iteration: i,
        done,
        total,
        lastTaskId: justDone.id,
        finishReason,
        reportCount: ctx.taskReports.length,
      },
    });
    return {
      kind: "return",
      result: finalizeSuccess(ctx, {
        lastAssistant: finalReport,
        aborted: false,
        correctionCount: ctx.correctionCount,
        documentWorkflow: ctx.documentWorkflowUpdate,
      }),
    };
  }

  if (content.trim()) {
    // 纯文本退出也必须更新 loopState，否则相似度 / 连续纯文本计数
    // 永远停在上一轮工具调用，中文近重复报告无法被第二层抓住。
    updateStateAfterResponse(ctx.loopState, {
      content,
      toolCalls: [],
      finishReason: finishReason ?? "stop",
      tokens: responseUsage.totalTokens,
      cost: (responseUsage.promptTokens / 1000) * 0.002 + (responseUsage.completionTokens / 1000) * 0.01,
    });
    // 近重复最终报告：仅当 history 末条已是助手文本时才跳过，
    // 避免「上一轮是工具调用、文本从未入史」时两份都丢。
    const lastHist = ctx.history[ctx.history.length - 1];
    const lastAlreadyHasReport =
      lastHist?.role === "assistant" && Boolean(lastHist.content?.trim());
    if (!(ctx.loopState.consecutiveSimilarOutputs >= 1 && lastAlreadyHasReport)) {
      ctx.history.push({ role: "assistant", content });
    }

  }
  logReasoningStep(ctx.reasoningTrace, {
    type: "observation",
    content: "Model returned a text response (no tool calls)",
    timestamp: Date.now(),
  });
  // 纯文本退出路径此前完全静默，排查"总中断"时无迹可寻。补一条事件日志，
  // 记录退出时的关键状态（上一轮是否执行了工具、nudge 计数、任务探索状态）。
  writeEventLog({
    category: "react_loop",
    message: `ReAct loop 因模型纯文本响应（无工具调用）退出 (iteration ${i})`,
    details: {
      stageId: ctx.stageId,
      iteration: i,
      finishReason,
      contentChars: content.length,
      contentPreview: content.slice(0, 200),
      toolsRanPreviousIter: toolsRanLastIter,
      postToolTextNudgeCount: ctx.postToolTextNudgeCount,
      taskDriven: ctx.taskDriven,
      currentTaskId: ctx.currentTask?.id ?? null,
      explorationComplete: (() => {
        const task = activeInformationTask(ctx);
        return task ? isExplorationComplete(task) : null;
      })(),
    },
  });

  if (ctx.currentStep) {
    ctx.currentStep.status = "completed";
    ctx.currentStep = selectNextStep(ctx.plan!);
  }

  return {
    kind: "return",
    result: finalizeSuccess(ctx, {
      lastAssistant: content,
      aborted: false,
      correctionCount: ctx.correctionCount,
      documentWorkflow: ctx.documentWorkflowUpdate,
    }),
  };
}
