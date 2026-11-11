/**
 * ReAct 循环的单轮工具执行。
 *
 * 从 react.ts 拆分：原 runReActLoop 内工具执行区段，含 OpenAI 协议调用构造、
 * 只读迭代计数与探索→实施过渡 nudge、终止状态更新、git 自动快照、
 * ask_user 单次提示规则、工具结果记录（messages/history/内存/新鲜度失效）、
 * 文档交付物与交还用户（handoff）检测、探索完成跳过、并行批处理。
 * 编排层保留"跳过剩余调用"循环——它必须在压缩与中止检查之后运行，
 * 因此本模块返回 nextTi 与 openaiCalls 供编排层按原顺序补记。
 */
import type { ChatMessage, ToolCall } from "@owncoder/llm";
import { executeTool } from "../execute.ts";
import { classifyRecoveryError } from "../recovery.ts";
import { type NormalizedUsage } from "../observability.ts";
import { FILE_MODIFYING_TOOLS } from "../auto-fix.ts";
import { gitAutoSnapshot } from "../checkpoint.ts";
import { PARALLEL_SAFE_TOOLS, READONLY_TOOLS } from "../enhanced-tools.ts";
import { formatBlockerReport } from "../tools/misc.ts";
import { isReadonlyBash } from "../terminal.ts";
import { logReasoningStep } from "../agent-reasoning.ts";
import {
  READ_INVALIDATING_TOOLS,
  READONLY_TRANSITION_THRESHOLD,
  SOURCE_READ_TOOLS,
  isExplorationComplete,
} from "./react-steps.ts";
import {
  summarizeToolActionForUser,
  summarizeToolResultForHistory,
} from "./react-prompt.ts";
import { buildSpecWorkflowUpdate, specPhaseOfTool } from "./document-workflow.ts";
import { featureDirRel } from "../../specs.ts";
import { updateStateAfterResponse } from "./termination.ts";
import { activeInformationTask, applyRunEvent, recordDecision } from "./react-finalize.ts";
import { type FreshnessFollowUp } from "./context-control.ts";
import { normalizeRel, toAbs } from "../tools/shared.ts";
import type { ParsedToolCall } from "../parser.ts";
import type { ReActLoopContext } from "./react-loop-context.ts";

/**
 * 证据板路径键：与 toolRead 的板键同一归一（toAbs + normalizeRel）。
 * 写工具参数可能是绝对路径、相对路径或带 ./ 前缀——统一成板键形式。
 */
function boardPathKey(ctx: ReActLoopContext, rawPath: string): string {
  const trimmed = String(rawPath ?? "").trim();
  if (!trimmed || !ctx.toolCtx.evidenceStore) return "";
  return normalizeRel(ctx.toolCtx.workspaceRoot, toAbs(ctx.toolCtx.workspaceRoot, trimmed));
}

/**
 * 同文件读取计数的路径键：与板键同一归一（toAbs + normalizeRel），
 * 但不依赖证据板是否存在——单 react 循环（无任务图）也需要计数。
 */
function readPathKey(ctx: ReActLoopContext, rawPath: string): string {
  const trimmed = String(rawPath ?? "").trim();
  if (!trimmed) return "";
  return normalizeRel(ctx.toolCtx.workspaceRoot, toAbs(ctx.toolCtx.workspaceRoot, trimmed));
}

/**
 * 同文件读取预算耗尽时，拦截对该文件的再次读取。计数只记成功读取；
 * 写操作使该文件计数归零（写后重读是合法需求）。
 */
function recordSameFileCapSkippedCall(ctx: ReActLoopContext, call: ParsedToolCall, id: string, pathKey: string): void {
  const output = `Skipped: ${pathKey} has already been read ${ctx.maxSameFileReads} times in this task; its content is in the context above. ` +
    "Do not read it again. Use the content already in context to apply the edit, or explain what is still missing.";
  ctx.opts.onEvent?.({ type: "tool_start", id, name: call.name, args: call.arguments });
  ctx.messages.push({ role: "tool", tool_call_id: id, name: call.name, content: output });
  ctx.history.push({ role: "tool", id, content: output, toolName: call.name, toolArgs: call.arguments });
  ctx.opts.onEvent?.({ type: "tool_end", id, name: call.name, ok: true, skipped: true, output });
}

/** 单轮工具执行的临时状态（替代原循环体内的闭包变量）。 */
interface ToolExecIterationState {
  askUserExecutedInBatch: boolean;
  executedToolResults: Array<{ name: string; arguments: Record<string, unknown>; result: string }>;
}

/** executeIterationTools 的显式结果：nextTi/openaiCalls 供编排层补记跳过调用。 */
export interface ToolExecutionOutcome {
  executedToolResults: Array<{ name: string; arguments: Record<string, unknown>; result: string }>;
  openaiCalls: ToolCall[];
  nextTi: number;
}

function emitFreshnessFollowUp(ctx: ReActLoopContext, update: FreshnessFollowUp | null): void {
  if (!update || !ctx.contextControl?.telemetryEnabled) return;
  ctx.opts.onEvent?.({
    type: "minimum_context_read_follow_up",
    ...update,
  });
}

async function runOne(
  ctx: ReActLoopContext,
  exec: ToolExecIterationState,
  i: number,
  calls: ParsedToolCall[],
  openaiCalls: ToolCall[],
  ti: number,
): Promise<{ call: ParsedToolCall; id: string; result: Awaited<ReturnType<typeof executeTool>> }> {
  const call = calls[ti]!;
  const id = openaiCalls[ti]!.id;
  const toolSpanId = ctx.tracer.startSpan(`tool_${call.name}`, "tool_call", {
    toolName: call.name,
    iteration: i,
  });
  ctx.opts.onEvent?.({ type: "tool_start", id, name: call.name, args: call.arguments });
  let result: Awaited<ReturnType<typeof executeTool>>;
  if (call.name === "ask_user") {
    if (exec.askUserExecutedInBatch) {
      result = {
        ok: true,
        output:
          "Skipped: only one ask_user is allowed per tool batch; reuse the first answer in this batch and do not re-ask.",
      };
    } else {
      exec.askUserExecutedInBatch = true;
      result = await executeTool(ctx.toolCtx, { ...call, id });
    }
  } else {
    result = await executeTool(ctx.toolCtx, { ...call, id });
  }
  if (!result.ok) {
    const recovery = classifyRecoveryError(result.output);

    ctx.opts.onEvent?.({
      type: "recovery",
      errorType: recovery.type,
      action: recovery.action,
      retryable: recovery.retryable,
      summary: recovery.summary,
    });
    recordDecision(ctx, {
      iteration: i,
      goal: ctx.currentTask?.executionGuidance ?? ctx.currentStep?.description ?? ctx.opts.userMessage.slice(0, 200),
      action: recovery.action,
      reasonSummary: recovery.summary,
      expectedObservation: "修复后获得成功结果或模型改换策略",
      actualObservationSummary: result.output,
      nextDecision: "retry",
      timestamp: Date.now(),
    });
    // 工具失败（含权限/用户决策类、整文件超限等）已写入 tool result，
    // 一律交回 LLM 自行纠错或改路径，不得因此打断 react 循环。
  }
  ctx.tracer.endSpan(toolSpanId, result.ok ? "ok" : "error");
  ctx.opts.onEvent?.({
    type: "tool_end",
    id,
    name: call.name,
    ok: result.ok,
    output: result.output,
    metadata: result.metadata,
  });
  return { call, id, result };
}

function recordResult(
  ctx: ReActLoopContext,
  exec: ToolExecIterationState,
  r: {
    call: ParsedToolCall;
    id: string;
    result: Awaited<ReturnType<typeof executeTool>>;
  },
): void {
  const toolMessage: ChatMessage = {
    role: "tool",
    tool_call_id: r.id,
    name: r.call.name,
    // 工具出口已完成脱敏；模型消息直接保留完整结果。
    content: r.result.output,
    is_error: !r.result.ok,
  };
  ctx.messages.push(toolMessage);

  const historySummary = summarizeToolResultForHistory(r.call, r.result);
  ctx.history.push({
    role: "tool",
    id: r.id,
    content: historySummary,
    toolName: r.call.name,
    // 任务结束后界面改用 history，必须保留与 tool_start 同一调用的参数。
    toolArgs: r.call.arguments,
  });
  ctx.memory.addToolOutput(r.call.name, historySummary);

  if (r.result.ok && READ_INVALIDATING_TOOLS.has(r.call.name)) {
    const modifiedPath = String(r.call.arguments?.path ?? "");
    if (modifiedPath) {
      emitFreshnessFollowUp(ctx, ctx.contextControl?.invalidatePath(modifiedPath) ?? null);
    }
    // 证据板同步失效：写后重读必须走磁盘（与 ContextControlState 失效语义一致）。
    const boardKey = boardPathKey(ctx, String(r.call.arguments?.file_path ?? r.call.arguments?.path ?? ""));
    if (boardKey) ctx.toolCtx.evidenceStore?.invalidatePath(boardKey);
    // 同文件读取计数归零：写后重读是合法需求，不应被预算拦截。
    const writtenKey = readPathKey(ctx, String(r.call.arguments?.file_path ?? r.call.arguments?.path ?? ""));
    if (writtenKey) ctx.sameFileReads.delete(writtenKey);
  }

  if (
    r.result.ok &&
    r.call.name === "bash" &&
    !isReadonlyBash(String(r.call.arguments?.command ?? ""))
  ) {
    emitFreshnessFollowUp(ctx, ctx.contextControl?.invalidateAll() ?? null);
    // 非只读 bash 可写任意路径：整板失效（与 ContextControlState.invalidateAll 同语义）。
    ctx.toolCtx.evidenceStore?.invalidateAll();
  }

  const resultMetadata = r.result.metadata;
  exec.executedToolResults.push({
    name: r.call.name,
    arguments: r.call.arguments ?? {},
    result: r.result.output,
  });
  if (r.result.ok && resultMetadata?.kind === "file_mutation") {
    for (const modifiedPath of resultMetadata.paths) {
      emitFreshnessFollowUp(ctx, ctx.contextControl?.invalidatePath(modifiedPath) ?? null);
      // 证据板同步失效（metadata 路径已是相对形式，归一幂等）。
      const boardKey = boardPathKey(ctx, modifiedPath);
      if (boardKey) ctx.toolCtx.evidenceStore?.invalidatePath(boardKey);
      // 同文件读取计数归零（写后重读合法）。
      const writtenKey = readPathKey(ctx, modifiedPath);
      if (writtenKey) ctx.sameFileReads.delete(writtenKey);
    }
  }

  if (r.result.ok && (resultMetadata?.kind === "read_file" || resultMetadata?.kind === "read_outline")) {
    if (resultMetadata.kind === "read_file") {
      emitFreshnessFollowUp(ctx, ctx.contextControl?.recordFreshRead(resultMetadata) ?? null);
    }
    // All successful source reads consume the same per-file budget. In
    // particular, read_outline must not bypass the cap merely because it has
    // navigation metadata instead of read_file metadata.
    const readKey = readPathKey(ctx, String(
      r.call.arguments?.file_path ?? r.call.arguments?.path ?? resultMetadata.path ?? "",
    ));
    if (readKey) ctx.sameFileReads.set(readKey, (ctx.sameFileReads.get(readKey) ?? 0) + 1);
  }

  // 文件修改类工具执行后，向对话流推一条 assistant 总结，让用户看到行动反馈（解决静默执行）。
  // 写入 history（UI 可见 + 持久化）；当前轮不进 messages，下一轮作为历史记录可见，不干扰本轮 LLM 决策。
  const userSummary = summarizeToolActionForUser(r.call.name, r.result);
  if (userSummary) {
    ctx.history.push({ role: "assistant", content: userSummary });
  }
  // ── Spec 阶段文档检测：save_spec/save_design/save_tasks 成功后停止本轮，等待用户审批。 ──
  if (ctx.docDeliverableEnabled && ctx.opts.mode === "spec" && !ctx.documentDelivered && r.result.ok) {
    const phase = specPhaseOfTool(r.call.name);
    const feature = String(r.call.arguments?.feature ?? "").trim();
    if (phase && feature) {
      ctx.documentDelivered = true;
      ctx.deliveredDocName = `${phase}.md`;
      // 仅在尚未设置工作流状态时才创建新状态，避免后续阶段覆盖当前审批闸门
      if (ctx.documentWorkflowUpdate === undefined) {
        ctx.documentWorkflowUpdate = buildSpecWorkflowUpdate(
          { feature, path: `${featureDirRel(feature)}/${phase}.md`, phase },
          ctx.opts.documentWorkflow,
        );
      }
    }
  }
  // ── 交还用户检测：report_blocker 成功即终止本轮，不再执行后续调用。 ──
  if (!ctx.handoffRequested && r.result.ok && r.call.name === "report_blocker") {
    ctx.handoffRequested = true;
    ctx.handoffReport = formatBlockerReport(
      String(r.call.arguments?.reason ?? ""),
      String(r.call.arguments?.summary ?? ""),
      String(r.call.arguments?.userAction ?? ""),
      String(r.call.arguments?.completed ?? ""),
    );
  }
}

/** 为跳过未执行的调用记录占位 tool result（handoff / 文档交付后由编排层补记）。 */
export function recordSkippedCall(ctx: ReActLoopContext, call: ParsedToolCall, id: string): void {
  const output = ctx.handoffRequested
    ? "Skipped: control was handed back to the user by report_blocker."
    : `Skipped: document ${ctx.deliveredDocName} is awaiting user confirmation.`;
  ctx.opts.onEvent?.({ type: "tool_start", id, name: call.name, args: call.arguments });
  ctx.messages.push({ role: "tool", tool_call_id: id, name: call.name, content: output });
  ctx.history.push({ role: "tool", id, content: output, toolName: call.name, toolArgs: call.arguments });
  ctx.opts.onEvent?.({ type: "tool_end", id, name: call.name, ok: true, skipped: true, output });
}

function recordExplorationSkippedCall(ctx: ReActLoopContext, call: ParsedToolCall, id: string): void {
  const output = "Skipped: verified information evidence satisfies every exploration stop criterion; proceed with an edit, verification, blocker, or final result.";
  ctx.opts.onEvent?.({ type: "tool_start", id, name: call.name, args: call.arguments });
  ctx.messages.push({ role: "tool", tool_call_id: id, name: call.name, content: output });
  ctx.history.push({ role: "tool", id, content: output, toolName: call.name, toolArgs: call.arguments });
  ctx.opts.onEvent?.({ type: "tool_end", id, name: call.name, ok: true, skipped: true, output });
}

/**
 * 连续只读迭代达到 maxConsecutiveReadonlyIters 硬上限时，拦截后续只读调用。
 * nudge 只在第 3~5 轮劝阻；上限之后必须机械拦截，否则模型会一路读到
 * maxIterations（39）才停。计数在模型使用写/生产工具时重置，因此
 * 读→写→读→写 的正常节奏不受影响。
 */
function recordReadonlyCapSkippedCall(ctx: ReActLoopContext, call: ParsedToolCall, id: string): void {
  const output = `Skipped: the read budget is exhausted (${ctx.maxConsecutiveReadonlyIters} consecutive read-only iterations). ` +
    "Do not read, search, or list again. Act on the evidence already in context: apply the edit, run the specified verification, or report the result.";
  ctx.opts.onEvent?.({ type: "tool_start", id, name: call.name, args: call.arguments });
  ctx.messages.push({ role: "tool", tool_call_id: id, name: call.name, content: output });
  ctx.history.push({ role: "tool", id, content: output, toolName: call.name, toolArgs: call.arguments });
  ctx.opts.onEvent?.({ type: "tool_end", id, name: call.name, ok: true, skipped: true, output });
}

/** 执行本轮全部工具调用（并行批处理 + 顺序执行混合），返回协议调用与停止位置。 */
export async function executeIterationTools(
  ctx: ReActLoopContext,
  i: number,
  calls: ParsedToolCall[],
  content: string,
  finishReason: string | null,
  responseUsage: NormalizedUsage,
): Promise<ToolExecutionOutcome> {
  // 本轮执行了工具：若下一轮模型只输出纯文本，nudge 才有依据。
  ctx.prevIterHadToolCalls = true;
  const openaiCalls: ToolCall[] = calls.map((c, idx) => ({
    id: c.id || `call_${ctx.stageId}_${i}_${idx}`,
    type: "function" as const,
    function: { name: c.name, arguments: JSON.stringify(c.arguments ?? {}) },
  }));

  ctx.totalToolCalls += calls.length;
  applyRunEvent(ctx, {
    type: "tool_completed",
    taskId: ctx.opts.sessionId,
    tool: calls.map((c) => c.name).join(","),
    ok: true,
    count: calls.length,
  });

  // ── Consecutive read-only iterations check ──
  // When the model produces no text and only calls read-only tools (list_dir, read_file, etc.),
  // it may be stuck in an infinite exploration/browsing loop.
  // NOTE: we intentionally do NOT reset the counter when the model produces text alongside
  // read-only tool calls — "let me read this file..." + read_file is still pure exploration
  // and should count toward the readonly-iteration cap.
  const allReadonly = calls.every((c) => READONLY_TOOLS.has(c.name));
  if (allReadonly) {
    ctx.consecutiveReadonlyIters++;
  } else {
    // Reset only when the model actually uses a write/production tool (save_plan, write_file, etc.)
    ctx.consecutiveReadonlyIters = 0;
  }

  // ── Soft transition nudge: push exploration → implementation ──
  // Before checkTermination's hard caps fire, inject a gentle nudge when
  // the model has spent several consecutive iterations on read-only tools.
  // This directly addresses the "总中断" bug: the agent keeps exploring
  // without transitioning to implementation. The nudge is injected AFTER
  // tool results are recorded (so the model has the facts) but BEFORE the
  // next LLM call, steering it toward producing output.
  // 必要门槛：探索尚未完成（无 information task / 探索已完成 → 信任 LLM，不引导）。
  const readonlyNudgeInfoTask = activeInformationTask(ctx);
  const readonlyNudgePendingExploration =
    !!readonlyNudgeInfoTask &&
    !isExplorationComplete(readonlyNudgeInfoTask);
  if (
    ctx.loopNudgeEnabled &&
    readonlyNudgePendingExploration &&
    allReadonly &&
    ctx.consecutiveReadonlyIters >= READONLY_TRANSITION_THRESHOLD &&
    ctx.consecutiveReadonlyIters < ctx.maxConsecutiveReadonlyIters
  ) {
    ctx.messages.push({
      role: "system",
      content:
        `You have used only exploration tools (read/search/browse) for ${ctx.consecutiveReadonlyIters} consecutive iterations without entering the implementation phase. ` +
        `Based on the information already gathered, transition to implementation now: use apply_patch / write_file to edit files, run type_check / bash to verify, or give a final conclusion. ` +
        `If you lack a codebase fact, do exactly one targeted local read. If you lack external knowledge (error/docs/API/library) and have not searched yet, call web_search once, then implement. Otherwise stop exploring and start implementing immediately.`,
    });
    logReasoningStep(ctx.reasoningTrace, {
      type: "observation",
      content: `${ctx.consecutiveReadonlyIters} consecutive read-only exploration iterations, injecting transition nudge (exploration → implementation)`,
      timestamp: Date.now(),
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Termination state: update after model response (before tool execution)
  // Stuck / tool-cap hard stops live in checkTermination — tool errors never
  // force-block here; results (including failures) always return to the model.
  // ═══════════════════════════════════════════════════════════════════════════
  const openaiCallsForTermination: ToolCall[] = calls.map((c, idx) => ({
    id: c.id || `call_${ctx.stageId}_${i}_${idx}`,
    type: "function" as const,
    function: {
      name: c.name,
      arguments: JSON.stringify(c.arguments || {}),
    },
  }));

  updateStateAfterResponse(ctx.loopState, {
    content: content,
    toolCalls: openaiCallsForTermination,
    finishReason: finishReason,
    tokens: responseUsage.totalTokens,
    cost: (responseUsage.promptTokens / 1000) * 0.002 + (responseUsage.completionTokens / 1000) * 0.01,
  });

  ctx.messages.push({
    role: "assistant",
    content: content || null,
    tool_calls: openaiCalls,
  });
  ctx.history.push({
    role: "assistant",
    // Tool calls are already represented by the structured tool events below;
    // do not turn a textless response into a visible tool-name chain.
    content: content || "",
  });

  // ── Git Auto-Snapshot: checkpoint before any file-modifying tools execute ──
  // Surface genuine failures: the tools below will happily report success
  // whether or not the safety net actually got created, so a silent failure
  // leaves the user believing they can roll back when they cannot.
  const hasFileModifyingTool = calls.some((c) => FILE_MODIFYING_TOOLS.has(c.name));
  if (ctx.gitSnapshotEnabled && hasFileModifyingTool && ctx.opts.mode !== "spec") {
    const snapshot = await gitAutoSnapshot(
      ctx.toolCtx.workspaceRoot,
      `before-${ctx.stageId ?? "execute"}`,
    );
    if (!snapshot.ok && snapshot.reason === "failed" && !ctx.gitSnapshotWarned) {
      ctx.gitSnapshotWarned = true; // once per turn — don't spam every iteration
      ctx.opts.onEvent?.({
        type: "warning",
        message: `Git auto-snapshot creation failed (${snapshot.error ?? "unknown reason"}). This turn's file modifications cannot be rolled back via Git snapshot. Session checkpoints remain available.`,
      });
    }
  }

  // ── Execute tool calls ──
  // Consecutive parallel-safe calls (pure reads: read_file, grep, lsp_*, …)
  // run concurrently; writes / bash / memory mutations / unknown tools run
  // sequentially. Results are always recorded in the original call order so
  // the OpenAI tool-call protocol and history stay deterministic.
  // ask_user is never parallel-safe; still allow at most one real prompt per
  // model tool batch so the UI is not asked twice in the same React iteration.
  const exec: ToolExecIterationState = { askUserExecutedInBatch: false, executedToolResults: [] };

  let skippedExploration = false;
  let skippedReadonlyCap = false;
  let ti = 0;
  while (ti < calls.length) {
    if (ctx.documentDelivered || ctx.handoffRequested) break;
    // 连续只读硬上限：超过预算的只读调用一律拦截，交回模型强制转入实施。
    if (
      ctx.consecutiveReadonlyIters >= ctx.maxConsecutiveReadonlyIters &&
      READONLY_TOOLS.has(calls[ti]!.name)
    ) {
      recordReadonlyCapSkippedCall(ctx, calls[ti]!, openaiCalls[ti]!.id);
      skippedReadonlyCap = true;
      ti++;
      continue;
    }
    // 同文件重复读上限：内容已在上下文，第 N+1 次读取拦截。
    if (SOURCE_READ_TOOLS.has(calls[ti]!.name)) {
      const pathKey = readPathKey(ctx, String(calls[ti]!.arguments?.file_path ?? calls[ti]!.arguments?.path ?? ""));
      if (pathKey && (ctx.sameFileReads.get(pathKey) ?? 0) >= ctx.maxSameFileReads) {
        recordSameFileCapSkippedCall(ctx, calls[ti]!, openaiCalls[ti]!.id, pathKey);
        ti++;
        continue;
      }
    }
    const informationTask = activeInformationTask(ctx);
    if (
      informationTask &&
      isExplorationComplete(informationTask) &&
      READONLY_TOOLS.has(calls[ti]!.name)
    ) {
      recordExplorationSkippedCall(ctx, calls[ti]!, openaiCalls[ti]!.id);
      skippedExploration = true;
      ti++;
      continue;
    }
    if (ctx.toolExecParallel && PARALLEL_SAFE_TOOLS.has(calls[ti]!.name)) {
      // Gather the run of consecutive parallel-safe calls.
      const batch: number[] = [];
      while (ti < calls.length && PARALLEL_SAFE_TOOLS.has(calls[ti]!.name)) {
        batch.push(ti);
        ti++;
      }
      if (batch.length === 1) {
        recordResult(ctx, exec, await runOne(ctx, exec, i, calls, openaiCalls, batch[0]!));
      } else {
        const results = await Promise.all(batch.map((idx) => runOne(ctx, exec, i, calls, openaiCalls, idx)));
        for (const r of results) recordResult(ctx, exec, r);
      }
    } else {
      recordResult(ctx, exec, await runOne(ctx, exec, i, calls, openaiCalls, ti));
      ti++;
    }
  }

  if (skippedExploration) {
    ctx.messages.push({
      role: "system",
      content: "Verified information evidence satisfies every exploration stop criterion. Do not explore further; continue with an edit, verification, report_blocker, or final result.",
    });

    // 🔥 NEW: 更新探索跳过计数
    // 探索完成后模型继续尝试探索工具，记录跳过次数
    if (ctx.loopState.lastIterationHadExplorationSkip) {
      // 连续两轮都有跳过，递增计数
      ctx.loopState.explorationSkipCount++;
    } else {
      // 第一次跳过，重置计数
      ctx.loopState.explorationSkipCount = 1;
    }
    ctx.loopState.lastIterationHadExplorationSkip = true;
  } else {
    // 本轮没有跳过，重置计数和标记
    ctx.loopState.lastIterationHadExplorationSkip = false;
    ctx.loopState.explorationSkipCount = 0;  // 🔥 重置计数
  }

  if (skippedReadonlyCap) {
    ctx.messages.push({
      role: "system",
      content: `The read budget is exhausted (${ctx.maxConsecutiveReadonlyIters} consecutive read-only iterations). Reading more will not help: the answer must come from the evidence already in this context. Apply the edit, run the task's specified verification, or report what is blocking the result.`,
    });
  }

  return { executedToolResults: exec.executedToolResults, openaiCalls, nextTi: ti };
}
