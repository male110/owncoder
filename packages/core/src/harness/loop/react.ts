/**
 * ReAct 主循环（Enhanced Tool-Calling Stage）。
 *
 * 从 react.ts 拆分：runReActLoop 的循环状态此前全部是函数体内的闭包变量，
 * 无法逐字提取到独立模块。拆分后循环状态收敛到显式的 ReActLoopContext
 * （react-loop-context.ts），各阶段按职责拆分为独立模块：
 * - react-finalize.ts —— 任务运行状态记账与终态封装
 * - react-termination-check.ts —— 迭代终止检查（含开发环境遥测）
 * - react-llm-call.ts —— 单轮 LLM 调用（含重试与空响应兜底）
 * - react-text-branch.ts —— 纯文本响应分支（nudge / 任务推进 / 退出）
 * - react-tool-exec.ts —— 单轮工具执行（含并行批处理与结果记录）
 * 本文件保留循环骨架：配置派生、每轮消息构造、工具调用解析与未知工具纠错、
 * 跳过剩余调用（skip-remaining）补记、中止检查、
 * 交还用户/文档交付返回、auto-fix 与终局兜底。
 */
import { writeEventLog } from "@owncoder/llm";
import { defaultReactSteps, type ReactStepConfig } from "@owncoder/settings";

import {
  createLoopState,
  updateStateAfterTools,
  createTerminationConfig,
  type LoopState,
  type TerminationConfig,
} from "./termination.ts";
import { modelNeedsLoopNudge } from "./continuation-intent.ts";

import {
  MAX_CONSECUTIVE_READONLY_ITERS,
  MAX_REPEAT_TOOL_CALLS,
  MAX_SAME_FILE_READS,
  MAX_TOTAL_TOOL_CALLS,
  findClosestToolName,
  stepBool,
  stepEnabled,
  stepNum,
} from "./react-steps.ts";
import { lastAssistantSummaryFromHistory } from "./react-prompt.ts";

import { parseToolCallsFromAssistant, normalizeToolName } from "../parser.ts";
import { logReasoningStep, selectNextStep } from "../agent-reasoning.ts";
import type { DocumentWorkflowState, ReActLoopArgs, ReactDecisionSummary } from "./types.ts";
import { autoFixAfterTools, createAutoFixState, getDirtyFiles, isAdvisoryVerificationResult } from "../auto-fix.ts";
import { createTaskRunState, restoreTaskRunState, type TaskRunState } from "../../task-run.ts";
import { applyTaskListOps, selectNextPendingTask, type TaskItem } from "../../plans.ts";

import type { ReActLoopContext } from "./react-loop-context.ts";
import {
  applyRunEvent,
  exitNoPendingTasks,
  finalizeSuccess,
  finalizeTerminal,
  persistTaskUpdate,
  recordDecision,
  syncLoopTask,
} from "./react-finalize.ts";
import { callModelForIteration } from "./react-llm-call.ts";
import { handleTerminationCheck } from "./react-termination-check.ts";
import { handleTextResponse } from "./react-text-branch.ts";
import { executeIterationTools, recordSkippedCall } from "./react-tool-exec.ts";
import { forcedFinalReport } from "./react-forced-report.ts";

// ── ReAct Loop (Enhanced Tool-Calling Stage) ───────────────

export async function runReActLoop(args: ReActLoopArgs): Promise<{
  lastAssistant: string;
  aborted: boolean;
  /** A document deliverable was written and requires user confirmation. */
  awaitingUserConfirmation?: boolean;
  /**
   * The model called `report_blocker`: the remaining work belongs to the user.
   * A successful terminal state, distinct from `aborted`. Suppresses every
   * autonomous follow-up (verify / post_verify / auto-fix / task auto-advance)
   * while still allowing changes made before the handoff to be presented.
   */
  handoffRequested?: boolean;
  /** Defined only when this turn changes the persisted document workflow. */
  documentWorkflow?: DocumentWorkflowState | null;
  blocked?: boolean;
  blockedReason?: string;
  correctionCount: number;
  /** 本轮结束时的统一任务运行状态。 */
  taskRunState?: TaskRunState | null;
  /** 成功门禁拒绝时为 true。 */
  successRejected?: boolean;
  decisionSummaries?: ReactDecisionSummary[];
}> {
  const {
    opts, model, messages, history, toolsFinal, toolCtx, maxIter, stageId,
    reasoningTrace, memory, tracer, plan, transientInformationTask, contextControl,
    maxRepeatToolCalls: _mrt,
    maxTotalToolCalls: _mttc,
    maxConsecutiveReadonlyIters: _mcri,
    maxSameFileReads: _msfr,
    // Legacy stuck-detect knobs kept on ReActLoopArgs for API compatibility.
    maxPagesPerFile: _mpf,
    maxRedundantRangesPerFile: _mrr,

  } = args;
  void _mpf;
  void _mrr;

  // ── Resolve reactSteps config from node params ──────────────────────────────
  const reactSteps: ReactStepConfig[] = args.reactSteps ?? defaultReactSteps();

  // ── Derive loop thresholds from reactSteps (override with legacy args if present) ──
  const maxRepeatToolCalls =
    _mrt ?? stepNum(reactSteps, "stuck_detect", "maxRepeat", MAX_REPEAT_TOOL_CALLS);
  const maxTotalToolCalls =
    _mttc ?? stepNum(reactSteps, "tool_cap", "maxTotal", MAX_TOTAL_TOOL_CALLS);
  const maxConsecutiveReadonlyIters =
    _mcri ?? stepNum(reactSteps, "stuck_detect", "maxReadonlyIters", MAX_CONSECUTIVE_READONLY_ITERS);
  // 同文件重复读上限（stuck_detect.maxReadCount，UI 暴露的"同文件读取上限"）：
  // 超过该次数的同文件读取被拦截——内容已在上下文，重读只是浪费迭代。
  const maxSameFileReads =
    _msfr ?? stepNum(reactSteps, "stuck_detect", "maxReadCount", MAX_SAME_FILE_READS);
  const llmMaxRetries = stepNum(reactSteps, "llm_call", "maxRetries", 2);
  const stuckDetectEnabled = stepEnabled(reactSteps, "stuck_detect");
  const gitSnapshotEnabled = stepEnabled(reactSteps, "git_snapshot");
  const toolExecParallel = stepBool(reactSteps, "tool_exec", "parallel", true);
  const docDeliverableEnabled = stepEnabled(reactSteps, "doc_deliverable");
  const autoFixEnabled = stepEnabled(reactSteps, "auto_fix");
  const autoFixMaxAttempts = stepNum(reactSteps, "auto_fix", "maxAttempts", 3);

  // ── 弱模型容错：工具执行后模型返回纯文本（无新工具调用）时的 nudge 计数 ──
  // 默认信任 LLM。仅当「特定小模型 allowlist + LLM 返回纯文本 + 所需信息未拿到」同时满足才 nudge。
  // 「纯文本」= 本轮 LLM 响应无 tool_calls；用户输入不作为门槛。
  // postToolTextNudgeCount 保持单调策略：一旦 nudge 消耗就不回退，
  // 在整个循环生命周期内只增不减，达到上限后不再注入 nudge。
  // 弱模型检测（state_machine.weakModelDetection）关闭时全员不 nudge；
  // 开启时仅 allowlist 小模型可引导；未知/强模型不引导。
  // LLM 纯文本与信息缺失在各自 nudge 注入点再判定。
  const loopNudgeEnabled =
    stepBool(reactSteps, "state_machine", "weakModelDetection", true) &&
    modelNeedsLoopNudge(model.model);

  // ── Unified task execution state ──
  let taskRunState: TaskRunState | null = null;
  if (opts.mode === "agent") {
    const restored = restoreTaskRunState(opts.taskRunState, opts.sessionId);
    taskRunState = restored
      ? { ...restored, maxRepairAttempts: autoFixMaxAttempts }
      : createTaskRunState(opts.sessionId, autoFixMaxAttempts);
  }
  const autoFixState = createAutoFixState();
  /** 是否在本轮执行过会触发验证的文件改动（用于成功门禁）。 */
  const hadFileModifyingTools = false;
  /** 自动修复耗尽后的失败摘要（追加到最终报告，不中断流程）。 */
  const autoFixFailureSummary: string | null = null;

  // ── Task-driven state (需要在 termination config 之前) ──
  const taskDriven = opts.mode === "agent" && Array.isArray(opts.activeTasks) && opts.activeTasks.length > 0;
  let tasks: TaskItem[] = taskDriven ? opts.activeTasks!.map((t) => ({ ...t })) : [];
  /** Stable messages prefix at loop entry (system/context/decompose/user). */
  const messagePrefixLen = messages.length;
  const turnInformationTask: TaskItem | null = !taskDriven ? (transientInformationTask ?? null) : null;

  // ═══════════════════════════════════════════════════════════════════════════
  // New Termination System (零 nudge, 3 层终止) - 完全集成
  // ═══════════════════════════════════════════════════════════════════════════

  const terminationConfig: TerminationConfig = createTerminationConfig({
    maxIterations: maxIter,
    maxTotalToolCalls,
    maxSameToolRepeat: maxRepeatToolCalls,
    enableOutputSimilarityCheck: true,
    maxConsecutiveTextOnly: 2,
    enableBudgetLimits: true,
    enableStuckDetection: stuckDetectEnabled,
    enableTaskValidation: true,
  });

  const loopState: LoopState = createLoopState(undefined);

  // 循环共享状态：原 runReActLoop 的闭包变量收敛到显式上下文对象，
  // 数组/对象字段（messages、history、taskReports 等）原地修改即对全体可见，
  // 各阶段辅助函数通过 ctx 读写同一份状态（字段说明见 react-loop-context.ts）。
  const ctx: ReActLoopContext = {
    opts,
    model,
    messages,
    history,
    toolsFinal,
    toolCtx,
    stageId,
    reasoningTrace,
    memory,
    tracer,
    plan,
    contextControl,
    turnInformationTask,
    llmMaxRetries,
    maxConsecutiveReadonlyIters,
    maxSameFileReads,
    toolExecParallel,
    docDeliverableEnabled,
    gitSnapshotEnabled,
    loopNudgeEnabled,
    taskDriven,
    taskRunState,
    autoFixState,
    hadFileModifyingTools,
    autoFixFailureSummary,
    thinking: args.thinking,
    tasks,
    currentTask: null,
    messagePrefixLen,
    taskReports: [],
    terminationConfig,
    loopState,
    lastAssistant: "",
    correctionCount: args.correctionCount,
    currentStep: plan ? selectNextStep(plan) : null,
    decisionSummaries: [],
    postToolTextNudgeCount: 0,
    // 上一轮是否执行了工具调用（用于判断本轮是否为"工具执行后的纯文本响应"）
    prevIterHadToolCalls: false,
    gitSnapshotWarned: false,
    totalToolCalls: 0,
    consecutiveReadonlyIters: 0,
    // 同文件读取计数（按归一化路径）：超过 maxSameFileReads 即拦截；
    // 写操作与任务切换时清空。
    sameFileReads: new Map<string, number>(),
    // 写入 PRD/TDD 等文档交付物后置 true，停止后续自动生成，等待用户确认
    documentDelivered: false,
    deliveredDocName: "",
    documentWorkflowUpdate: undefined,
    // 模型调用 report_blocker 后置 true：剩余工作不属于 agent，本轮正常结束。
    // 这是成功终止，不是 aborted —— 但必须压制所有"继续推进"机制，否则模型会绕道
    // 去用别的手段达成同一个已被拦下的目标。
    handoffRequested: false,
    handoffReport: "",
  };
  // 工具错误（含权限/用户决策类）一律写入 tool result 交回 LLM，不再强制 blocked。

  applyRunEvent(ctx, { type: "phase_changed", taskId: opts.sessionId, phase: "executing" });

  // ── Hard step-driver state (approved plan tasks in agent mode) ──
  // taskDriven, tasks 已在上面定义
  if (ctx.taskDriven) {
    const startId = opts.currentTaskId ?? ctx.tasks[0]?.id ?? null;
    const selected = startId ? ctx.tasks.find((t) => t.id === startId) : undefined;
    ctx.currentTask = selected && (selected.status === "pending" || selected.status === "in_progress")
      ? selected
      : selectNextPendingTask(ctx.tasks);
    if (ctx.currentTask) {
      ctx.currentTask.status = "in_progress";
      await persistTaskUpdate(ctx, ctx.currentTask.id);
    }
  }

  // 启动时同步一次：无 active task 时也要清掉/挂上 turn information task，
  // 否则 termination 层拿不到正确的 currentTask，容易空转到硬上限。
  syncLoopTask(ctx);

  // update_tasks 顺序路径闭包（任务图路径由调度器经 opts.updateTasks 注入，
  // 这里不覆盖）：直接改共享的 ctx.tasks——applyTaskListOps 原地修改保持数组
  // 引用，text-branch 的任务推进与 react-llm-call 每轮重注入的
  // formatCurrentTaskContext 看到的都是同一份；持久化走既有 persistTaskUpdate
  // 通路（activePlan 写回 .active meta + task_update 事件下发 UI）。
  if (ctx.taskDriven && !ctx.opts.updateTasks) {
    ctx.toolCtx.updateTasks = async (ops) => {
      const applied = applyTaskListOps(ctx.tasks, ops);
      if (!applied.ok) return applied;
      await persistTaskUpdate(ctx, ctx.currentTask?.id ?? null);
      return { ok: true, summary: applied.summary };
    };
  }

  // task-driven 但没有任何可执行 pending/in_progress 任务：直接收尾，不要再进 LLM 循环。
  if (ctx.taskDriven && !ctx.currentTask) {
    return exitNoPendingTasks(ctx);
  }

  // task-driven 模式下，每个子任务独立享有 maxIter 次迭代预算，
  // 因此全局循环上限 = maxIter × 子任务数量。
  const totalIterBound = ctx.taskDriven ? maxIter * Math.max(ctx.tasks.length, 1) : maxIter;
  for (let i = 0; i < totalIterBound; i++) {
    // ═══════════════════════════════════════════════════════════════════════════
    // New Termination Check (在迭代开始时检查)
    // ═══════════════════════════════════════════════════════════════════════════
    const terminationExit = await handleTerminationCheck(ctx, i);
    if (terminationExit) return terminationExit;

    if (opts.signal?.aborted) {
      writeEventLog({
        category: "abort",
        message: `ReAct loop 中止 (turn start, iteration ${i}/${maxIter})`,
        details: {
          stageId,
          iteration: i,
          maxIterations: maxIter,
          lastAssistantLen: ctx.lastAssistant.length,
        },
      });
      return finalizeTerminal(ctx, { lastAssistant: ctx.lastAssistant, aborted: true, correctionCount: ctx.correctionCount }, "interrupted");
    }

    // Update working memory with current plan step
    if (ctx.currentStep) {
      ctx.currentStep.status = "in_progress";
      ctx.memory.working.activePlan!.currentStep = ctx.plan!.steps.indexOf(ctx.currentStep);
      ctx.memory.working.activePlan!.progress = `Executing step: ${ctx.currentStep.description}`;
    }

    // Earlier history is compacted before this loop into a separate LLM-generated
    // context message. Do not mutate `history` here: it is the source of truth
    // for the visible and persisted conversation.

    // ── Public decision summary (bounded; no private chain-of-thought) ──
    recordDecision(ctx, {
      iteration: i,
      goal: ctx.currentTask?.description ?? ctx.currentStep?.description ?? opts.userMessage.slice(0, 200),
      action: "llm_decide",
      reasonSummary: ctx.currentTask ? "依据当前任务和已收集证据决定下一步" : "依据当前上下文决定下一步",
      expectedObservation: "获得工具结果或可验证的下一步响应",
      timestamp: Date.now(),
    });

    // ── LLM Call (with retry) ──
    const llmOutcome = await callModelForIteration(ctx, i);
    if (llmOutcome.kind === "exit") return llmOutcome.result;
    const response = llmOutcome.response;
    const content = llmOutcome.content;
    const finishReason = llmOutcome.finishReason;
    const responseUsage = llmOutcome.responseUsage;

    const choice = response.choices[0]!.message;

// ── Parse tool calls ──
    const parsed = parseToolCallsFromAssistant({
      content,
      toolCalls: choice.tool_calls,
    });

    const known = new Set(ctx.toolsFinal.map((t) => t.function.name));

    // Normalize tool names through the alias map so weaker LLMs that output
    // "Read" / "Write" / "Edit" get routed to the correct built-in tools
    // instead of being silently dropped.
    const normalized = parsed.map((c) => ({
      ...c,
      name: normalizeToolName(c.name),
    }));

    // Collect calls whose name, even after normalization, does not match any
    // known tool — surface them as a synthetic tool-result error so the model
    // learns the correct name instead of repeating the mistake.
    const unknownCalls = normalized.filter((c) => !known.has(c.name));
    const calls = normalized.filter((c) => known.has(c.name));

    // If there were unknown tool names, inject their errors as tool results
    // so the model sees the feedback in the same turn.
    if (unknownCalls.length > 0) {
      for (const uc of unknownCalls) {
        const suggestion = findClosestToolName(uc.name, known);
        const msg = suggestion
          ? `Unknown tool "${uc.name}". Did you mean "${suggestion}"? Use the exact tool name as defined.`
          : `Unknown tool "${uc.name}". Available tools: ${[...known].sort().join(", ")}.`;
        ctx.messages.push({
          role: "tool",
          tool_call_id: uc.id,
          name: uc.name,
          content: `Error: ${msg}`,
        });
        ctx.history.push({ role: "tool", id: uc.id, content: `Error: ${msg}`, toolName: uc.name, toolArgs: uc.arguments });
      }
    }

  // ── 弱模型容错状态说明 ──
  // prevIterHadToolCalls 只由两个分支各自维护，不能在这里无条件覆盖（旧代码在此处
  // 赋 `calls.length > 0`，导致进入下方纯文本分支时该值恒为 false，工具执行后的
  // 纯文本 nudge 从未触发过——"总中断"bug 的直接原因）：
  // - 工具执行分支置 true（下一轮若为纯文本响应，nudge 才有依据）；
  // - 纯文本分支开头保留旧值用于判断，随即置 false（"只给一次额外机会"，
  //   模型连续两轮纯文本则尊重其结束意图，避免 nudge→文本→nudge 死循环）。
  // postToolTextNudgeCount 保持单调策略：一旦 nudge 消耗就不回退，
  // 在整个循环生命周期内只增不减，达到上限后不再注入 nudge。
  // ── 文档交付后若模型仍试图调用工具，强制停止等待用户确认 ──
  if (ctx.documentDelivered && calls.length > 0) {
    logReasoningStep(ctx.reasoningTrace, {
      type: "observation",
      content: "Model attempted tool calls after document delivery, force-stopping to await user confirmation",
      timestamp: Date.now(),
    });
    const fallback = ctx.lastAssistant || lastAssistantSummaryFromHistory(ctx.history) || `Document ${ctx.deliveredDocName} has been generated. Awaiting your confirmation before continuing.`;
    return finalizeSuccess(ctx, { lastAssistant: fallback, aborted: false, awaitingUserConfirmation: true, correctionCount: ctx.correctionCount });
  }

  // ── No tool calls: text response → reflect and finish ──
  if (calls.length === 0) {
    const textOutcome = await handleTextResponse(ctx, i, content, finishReason, responseUsage);
    if (textOutcome.kind === "return") return textOutcome.result;
    continue;
  }

  // ── Execute tools ──
  // Consecutive parallel-safe calls (pure reads: read_file, grep, lsp_*, …)
  // run concurrently; writes / bash / memory mutations / unknown tools run
  // sequentially. Results are always recorded in the original call order so
  // the OpenAI tool-call protocol and history stay deterministic.
  // ask_user is never parallel-safe; still allow at most one real prompt per
  // model tool batch so the UI is not asked twice in the same React iteration.
  const toolOutcome = await executeIterationTools(ctx, i, calls, content, finishReason, responseUsage);
  const { executedToolResults, openaiCalls, nextTi } = toolOutcome;

    // ═══════════════════════════════════════════════════════════════════════════
    // New Termination: Update state after tools executed
    // ═══════════════════════════════════════════════════════════════════════════
    if (executedToolResults.length > 0) {
      updateStateAfterTools(ctx.loopState, executedToolResults);
    }

    if (opts.signal?.aborted) {
      writeEventLog({
        category: "abort",
        message: `ReAct loop 中止 (after tools, iteration ${i})`,
        details: {
          stageId,
          iteration: i,
          totalToolCalls: ctx.totalToolCalls,
          lastAssistantLen: ctx.lastAssistant.length,
        },
      });
      return finalizeTerminal(ctx, { lastAssistant: ctx.lastAssistant, aborted: true, correctionCount: ctx.correctionCount }, "interrupted");
    }

    // ── 交还用户：report_blocker 已调用，本轮正常结束 ──
    // 放在 auto-fix 之前：auto-fix 会把模型重新拉回自主循环，而 handoff 的整个目的
    // 就是退出自主循环。剩余的类型错误留给下一轮，present_changes 仍会展示改动。
    if (ctx.handoffRequested) {
      // 剩余调用不再执行：按原顺序补记占位 tool result，保持协议与 history 确定性。
      let ti = nextTi;
      while (ti < calls.length) {
        recordSkippedCall(ctx, calls[ti]!, openaiCalls[ti]!.id);
        ti++;
      }
      const summary = ctx.handoffReport || ctx.lastAssistant || "Control has been handed back to you. Please review the explanation above.";
      logReasoningStep(ctx.reasoningTrace, {
        type: "observation",
        content: "Model called report_blocker to hand back control, stopping autonomous progression this turn",
        timestamp: Date.now(),
      });
      ctx.history.push({ role: "assistant", content: summary });
      opts.onEvent?.({ type: "assistant_delta", text: summary });
      return finalizeTerminal(ctx, {
        lastAssistant: summary,
        aborted: false,
        handoffRequested: true,
        documentWorkflow: ctx.documentWorkflowUpdate,
        correctionCount: ctx.correctionCount,
      }, "blocked");
    }

    // ── Plan 模式文档交付物：写入 PRD/TDD 等后立即停止，等待用户确认 ──
    if (ctx.documentDelivered) {
      // The assistant tool-call message already lists every call. Record a
      // non-side-effect result for calls skipped after the document write.
      let ti = nextTi;
      while (ti < calls.length) {
        recordSkippedCall(ctx, calls[ti]!, openaiCalls[ti]!.id);
        ti++;
      }
      const deliveredSummary = `Document generated: ${ctx.deliveredDocName}. Please confirm the content is correct before proceeding to the next step.`;
      logReasoningStep(ctx.reasoningTrace, {
        type: "observation",
        content: `Document deliverable detected (${ctx.deliveredDocName}), stopping further generation, awaiting user confirmation`,
        timestamp: Date.now(),
      });
      ctx.history.push({ role: "assistant", content: deliveredSummary });
      opts.onEvent?.({ type: "assistant_delta", text: deliveredSummary });
      return finalizeSuccess(ctx, {
        lastAssistant: deliveredSummary,
        aborted: false,
        awaitingUserConfirmation: true,
        documentWorkflow: ctx.documentWorkflowUpdate,
        correctionCount: ctx.correctionCount,
      });
    }

    // ── Auto-Fix Verification: auto type-check after file modifications ──
    const dirtyFiles = getDirtyFiles(calls);
    if (dirtyFiles.length > 0) ctx.hadFileModifyingTools = true;
    if (autoFixEnabled && dirtyFiles.length > 0 && opts.mode !== "spec" && opts.enableAutoFix !== false) {
      const fixResult = await autoFixAfterTools(
        toolCtx.workspaceRoot,
        dirtyFiles,
        ctx.autoFixState,
        {
          maxAttempts: autoFixMaxAttempts,
          autoTypeCheck: true,
          onEvent: (e) => {
            if (e.type === "fix_error") {
              logReasoningStep(ctx.reasoningTrace, {
                type: "observation",
                content: e.message,
                timestamp: Date.now(),
              });
            }
          },
        },
      );
      if (fixResult.finalVerification) {
        applyRunEvent(ctx, {
          type: "verification_completed",
          taskId: opts.sessionId,
          result: fixResult.finalVerification,
        });
        applyRunEvent(ctx, {
          type: "repair_completed",
          taskId: opts.sessionId,
          attempt: fixResult.attempts,
          resolved: fixResult.resolved,
        });
      }
      // semantic_diff「移除了导出」等建议性警告：不弹窗、不中断。
      // 硬错误达修复上限：不中断主流程，记录失败摘要，后续在最终报告中提示。
      if (fixResult.exhausted && !isAdvisoryVerificationResult(fixResult.finalVerification)) {
        ctx.autoFixFailureSummary = `自动修复失败（已尝试 ${autoFixMaxAttempts} 次）：${fixResult.summary}`;
        // 不重置 autoFixState：后续 auto-fix 调用会立即识别为已耗尽，避免无限重试。
      }
      // Inject verification error messages into the conversation for the next LLM turn.
      // 只注入到 messages（LLM 上下文），不写入 history（不展示为独立用户消息）。
      for (const msg of fixResult.injectedMessages) {
        ctx.messages.push(msg);
      }
      if (fixResult.resolved) {
        // Reset fix state on clean verification
        ctx.autoFixState.dirtyFiles = [];
        ctx.autoFixState.fixAttempts = 0;
        ctx.autoFixState.hasUnresolvedErrors = false;
      }
    }

    logReasoningStep(ctx.reasoningTrace, {
      type: "action",
      content: `Executed ${calls.length} tool calls: ${calls.map((c: typeof calls[0]) => c.name).join(", ")}`,
      timestamp: Date.now(),
    });
  }

  writeEventLog({
    category: "react_loop",
    message: `ReAct loop 退出: 达到最大迭代限制 (${maxIter})`,
    details: {
      stageId,
      maxIter,
      totalToolCalls: ctx.totalToolCalls,
      postToolTextNudgeCount: ctx.postToolTextNudgeCount,
      lastAssistantChars: ctx.lastAssistant.length,
    },
  });
  opts.onEvent?.({
    type: "warning",
    message: `已达到最大迭代限制（${maxIter} 次），任务可能尚未完成。可在流水线设置中调高"Max model/tool iterations"后重试。`,
  });

  const blockedReason = `已达到最大迭代限制（${maxIter} 次）`;
  // 没有任何结论文本时，先做一次无工具的强制总结，保证父智能体拿到
  // 已收集到的发现，而不是空占位语。未启用（主循环）时沿用历史摘要兜底。
  let finalText: string;
  if (opts.forcedFinalReportOnLimit && !ctx.lastAssistant.trim()) {
    finalText = await forcedFinalReport(ctx, blockedReason);
  } else {
    finalText =
      ctx.lastAssistant ||
      lastAssistantSummaryFromHistory(ctx.history) ||
      "(max iterations reached)";
  }

  // 达迭代上限不是成功：标记 blocked，避免绕过成功门禁。
  return finalizeTerminal(ctx, {
    lastAssistant: finalText,
    aborted: false,
    blocked: true,
    blockedReason,
    correctionCount: ctx.correctionCount,
  }, "failed");
}
