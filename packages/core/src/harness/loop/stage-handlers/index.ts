/**
 * StageHandler implementations for each pipeline node type (T8).
 *
 * Each handler owns one node type's behavior. The PipelineScheduler (T9) walks
 * the pipeline in graph order and dispatches to the matching handler via the
 * STAGE_HANDLERS registry. This replaces the hardcoded pre-loop processing and
 * the midStages switch in loop.ts — node position now truly determines execution
 * order.
 *
 * Behavior is extracted verbatim from the former loop.ts inline code so the
 * builtin pipeline produces identical results.
 */

import {
  assertLlmAuth,
  chatCompletionStream,
  writeEventLog,
} from "@owncoder/llm";
import type { PipelineNode } from "@owncoder/settings";
import { buildInitialContext } from "../context.ts";
import { emitStage } from "../stages.ts";
import { normalizeUsage } from "../../observability.ts";
import type { StageHandler, SchedulerContext } from "./types.ts";
import { pushCurrentUserMessageOnce } from "./history.ts";
import { flattenSteps, taskDecomposeHandler } from "./task-decompose.ts";
import { exploreToolsHandler, executeToolsHandler } from "./tools.ts";
import { verifyHandler, postVerifyHandler } from "./verify.ts";

// ── Re-exports ──────────────────────────────────────────────────────

export type {
  SchedulerState,
  SchedulerContext,
  StageHandlerContext,
  StageHandler,
} from "./types.ts";

export {
  computeHistoryLimits,
  historyCompactHandler,
  pushHistoryBlockToMessages,
  pushCurrentUserMessageOnce,
} from "./history.ts";

export {
  parseDecomposeAnswer,
  flattenSteps,
  injectStopConditions,
  runTaskDecompose,
  taskDecomposeHandler,
  extractStructuredHistory,
} from "./task-decompose.ts";

export {
  exploreToolsHandler,
  executeToolsHandler,
} from "./tools.ts";

export {
  runPostVerify,
  sealPostVerifyFailure,
  verifyHandler,
  postVerifyHandler,
} from "./verify.ts";

// ── Shared Helper Functions ────────────────────────────────────────

/**
 * Push the current user message (+ optional packed decompose context) into `messages`.
 * 方案A：执行上下文由任务分解结果提供；不再走 history_compact 的召回/过滤路径。
 * Fallback used when the history_compact handler does not inject (always, under 方案A).
 */
export async function injectHistoryAndUserMessage(ctx: SchedulerContext): Promise<void> {
  // 幂等性检查：如果已注入，直接返回（task_decompose 阶段可能已调用）
  if (ctx.state.userMessageInjected) {
    return;
  }

  const { opts, messages, history, state } = ctx;
  const { tagUserInput } = await import("../../message-tags.js");

  let recentFileHints = "";
  if (opts.sessionId) {
    const { loadRecentRounds, formatRecentFileHints } = await import("../../../turn-rounds.ts");
    const rounds = await loadRecentRounds(opts.workspaceRoot, opts.sessionId, 5);
    recentFileHints = formatRecentFileHints(rounds);
  }

  // 优先当前子任务 relevantHistory → 整单 relevantHistory；都没有则只注入当前用户消息（不再拉历史）
  const currentTaskId = opts.currentTaskId;
  const flatSteps = flattenSteps(state.rawDecompose);
  const stepHistory = currentTaskId
    ? flatSteps.find((s) => s.id === currentTaskId)?.relevantHistory
    : undefined;
  const firstStepHistory = flatSteps.find((s) => (s.relevantHistory?.trim().length ?? 0) > 0)?.relevantHistory;
  const relevantHistory = stepHistory
    ?? state.turnInformationTask?.relevantHistory
    ?? state.rawDecompose?.relevantHistory
    ?? firstStepHistory;

  const packedHistory = relevantHistory?.trim() ?? "";
  if (packedHistory) {
    const contextLines: string[] = [
      `## 当前任务`,
      ``,
      opts.userMessage,
      ``,
      `## 可复用历史信息（来自分解阶段，勿重复读取；可含文件及其它相关内容）`,
      ``,
      packedHistory,
    ];

    if (recentFileHints) {
      contextLines.push(``, recentFileHints);
    }

    messages.push({ role: "user", content: tagUserInput(contextLines.join("\n")) });

    writeEventLog({
      category: "other",
      message: "使用任务分解带回的可复用历史，跳过完整历史注入",
      details: {
        historyChars: packedHistory.length,
        source: stepHistory ? "step" : state.turnInformationTask?.relevantHistory ? "turn_task" : "shared",
      },
    });
  } else {
    // 即使没有可复用历史，也不再召回/过滤历史；只注入当前用户消息
    messages.push({
      role: "user",
      content: tagUserInput(
        recentFileHints
          ? `## 当前任务\n\n${opts.userMessage}\n\n${recentFileHints}`
          : `## 当前任务\n\n${opts.userMessage}`,
      ),
    });

    writeEventLog({
      category: "other",
      message: "无分解可复用历史，仅注入当前用户消息（不召回历史）",
      details: {
        historyTurns: opts.history.length,
      },
    });
  }

  pushCurrentUserMessageOnce(history, opts.userMessage);
}

/**
 * Plain LLM completion (no tool loop). Used when the pipeline has no
 * explore/execute node. Extracted from former loop.ts Path A.
 */
export async function doPlainCompletion(ctx: SchedulerContext): Promise<string> {
  const { opts, model, messages, history, tracer } = ctx;
  assertLlmAuth(model, opts.llmApiKey);
  let accumulated = "";
  try {
    const spanId = tracer.startSpan("plain_completion", "llm_call");
    const response = await chatCompletionStream(model, messages, {
      signal: opts.signal,
      apiKey: opts.llmApiKey,
      purpose: "plain_completion",
      taskId: opts.sessionId,
      onDelta: (text: string) => { accumulated += text; opts.onEvent?.({ type: "assistant_delta", text }); },
      onThinkingDelta: (text: string) => opts.onEvent?.({ type: "thinking_delta", text }),
      thinking: { effort: opts.workflow.thinking?.defaultEffort },
    });
    tracer.endSpan(spanId, "ok");
    const content = response.choices[0]!.message.content ?? "";
    const usage = normalizeUsage(
      response.usage,
      messages.map((message) => String(message.content ?? "")).join("\n"),
      content,
    );
    tracer.recordTokenUsage(usage.promptTokens, usage.completionTokens);
    if (content.trim()) history.push({ role: "assistant", content });
    return content;
  } catch (e) {
    if (opts.signal?.aborted) {
      ctx.state.aborted = true;
      writeEventLog({
        category: "abort",
        message: `doPlainCompletion 中止 (signal aborted)`,
        details: {
          sessionId: opts.sessionId,
          accumulatedChars: accumulated.length,
          error: e instanceof Error ? e.message : String(e),
        },
      });
      // 保留中断前已生成的 assistant 文本，避免 cancel 丢失用户已看到的回复
      if (accumulated.trim()) history.push({ role: "assistant", content: accumulated });
      return accumulated;
    }
    const msg = e instanceof Error ? e.message : String(e);
    writeEventLog({
      category: "stage_error",
      message: `doPlainCompletion LLM 调用失败: ${msg}`,
      details: {
        sessionId: opts.sessionId,
        error: msg,
        stack: e instanceof Error ? e.stack : undefined,
      },
    });
    opts.onEvent?.({ type: "error", message: msg });
    return "";
  }
}

// ── Additional Handlers ─────────────────────────────────────────────

/** context_gather: assemble project context (rules, memories, tech stack, project size, anchors). */
const contextGatherHandler: StageHandler = {
  async run(ctx) {
    const { opts, memory, budgets, messages, state, node, anchorsNode } = ctx;
    const result = await buildInitialContext({
      opts,
      memory,
      budgets,
      systemPrompt: messages[0]?.content ?? "",
      contextNode: node,
      anchorsNode,
      messages,
    });
    state.budgetUsed = result.budgetUsed;
    state.contextControl = result.contextControl;
    state.fixedSegments = result.fixedSegments;
    state.tokenBudget = result.tokenBudget;
    memory.working.contextBudget = { used: result.budgetUsed, total: budgets.total };
  },
};

/** present_changes: mark for Keep/Undo review UI. */
const presentChangesHandler: StageHandler = {
  async run(ctx) {
    const { opts, node } = ctx;
    emitStage(opts.onEvent, "start", node);
    emitStage(opts.onEvent, "done", node);
  },
};

// ── Handler Registry ───────────────────────────────────────────────

// `document_intent_router` and `agent_intent_router` are deliberately absent:
// the nodes are gone, and an unmapped type is skipped by the scheduler, so a
// saved pipeline still holding one degrades to a no-op until the migrator drops
// it rather than throwing.
export const STAGE_HANDLERS: ReadonlyMap<string, StageHandler> = new Map([
  ["context_gather", contextGatherHandler],
  ["task_decompose", taskDecomposeHandler],
  ["explore_tools", exploreToolsHandler],
  ["execute_tools", executeToolsHandler],
  ["verify", verifyHandler],
  ["post_verify", postVerifyHandler],
  ["present_changes", presentChangesHandler],
]);

/** Node types that trigger a model call (need user message in `messages` first). */
const MODEL_CALLING_TYPES = new Set(["explore_tools", "execute_tools"]);

/** Node types that run after the model call. */
const POST_MODEL_TYPES = new Set(["verify", "post_verify", "present_changes"]);

export function isModelCallingStage(node: PipelineNode): boolean {
  return MODEL_CALLING_TYPES.has(node.type);
}

export function isPostModelStage(node: PipelineNode): boolean {
  return POST_MODEL_TYPES.has(node.type);
}
