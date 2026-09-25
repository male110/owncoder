/**
 * Tool execution stage handlers (explore_tools and execute_tools).
 *
 * These handlers invoke the ReAct loop with tool access, either read-only (explore)
 * or read/write (execute), depending on the agent mode and pipeline configuration.
 */

import { assertLlmAuth } from "@owncoder/llm";
import { resolveStageModel, emitStage } from "../stages.ts";
import { resolveLoopStrategy } from "../loop-strategy.ts";
import type { AgentLoopOpts } from "../types.ts";
import type { SchedulerState, StageHandler, StageHandlerContext } from "./types.ts";
import { flattenSteps } from "./task-decompose.ts";

/** 把分解结果中的可复用历史合并进 activeTasks，供 ReAct 循环直接使用。 */
function withDecomposeHistory(opts: AgentLoopOpts, state: SchedulerState): AgentLoopOpts {
  const steps = flattenSteps(state.rawDecompose);
  if (!steps.length || !opts.activeTasks?.length) return opts;
  const byId = new Map(steps.map((s) => [s.id, s.relevantHistory]));
  const shared = state.rawDecompose?.relevantHistory;
  const activeTasks = opts.activeTasks.map((task) => {
    if (task.relevantHistory?.trim()) return task;
    const fromStep = byId.get(task.id) ?? shared;
    return fromStep ? { ...task, relevantHistory: fromStep } : task;
  });
  return { ...opts, activeTasks };
}

/** Shared ReAct loop invocation for explore/execute handlers. */
async function runToolLoop(ctx: StageHandlerContext): Promise<void> {
  const {
    opts, messages, history, toolsFinal, toolCtx, memory, tracer,
    reasoningTrace, state, node, taskClassification,
  } = ctx;

  // 使用分阶段模型配置（如果启用）
  const stageModel = resolveStageModel(opts.workflow, opts.mode, node, "react");
  assertLlmAuth(stageModel, opts.llmApiKey);
  const maxIter = opts.maxIterations ?? node.params?.maxIterations ?? 200;
  emitStage(opts.onEvent, "start", node);

  const loopSpanId = tracer.startSpan("react_loop", "stage", {
    mode: opts.mode,
    maxIterations: maxIter,
    taskType: taskClassification.taskType,
    complexity: taskClassification.complexity,
  });

  const loopParams = node.params ?? {};
  const enrichedOpts = withDecomposeHistory(opts, state);

  const reactResult = await resolveLoopStrategy(loopParams.loopStrategy).run({
    opts: enrichedOpts,
    model: stageModel,
    messages,
    history,
    toolsFinal,
    toolCtx,
    maxIter,
    stageId: node.id,
    reasoningTrace,
    memory,
    tracer,
    plan: state.currentPlan,
    transientInformationTask: state.turnInformationTask,
    contextControl: state.contextControl,
    correctionCount: state.correctionCount,
    maxRepeatToolCalls: loopParams.maxRepeatToolCalls,
    maxTotalToolCalls: loopParams.maxTotalToolCalls,
    maxSameFileReads: loopParams.maxSameFileReads,
    maxConsecutiveReadonlyIters: loopParams.maxConsecutiveReadonlyIters,
    maxEmptyResponses: loopParams.maxEmptyResponses,
    maxPagesPerFile: loopParams.maxPagesPerFile,
    maxRedundantRangesPerFile: loopParams.maxRedundantRangesPerFile,
    // ── Pass reactSteps from node.params so UI config takes effect at runtime ──
    reactSteps: loopParams.reactSteps,
  });

  tracer.endSpan(loopSpanId, reactResult.aborted ? "error" : "ok");
  state.lastAssistant = reactResult.lastAssistant;
  state.correctionCount = reactResult.correctionCount;
  if (reactResult.blocked) {
    state.blocked = true;
    state.blockedReason = reactResult.blockedReason;
  }

  emitStage(opts.onEvent, "done", node);

  if (reactResult.aborted) {
    state.aborted = true;
  }
  if (reactResult.awaitingUserConfirmation) {
    state.awaitingUserConfirmation = true;
  }
  if (reactResult.handoffRequested) {
    state.handoffRequested = true;
  }
  if (reactResult.documentWorkflow !== undefined) {
    state.documentWorkflow = reactResult.documentWorkflow;
  }
  if (reactResult.taskRunState !== undefined) {
    state.taskRunState = reactResult.taskRunState;
  }
  if (reactResult.successRejected) {
    state.successRejected = true;
    state.blocked = true;
    state.blockedReason = reactResult.blockedReason ?? state.blockedReason ?? "成功门禁未通过";
  }
}

// ── Stage Handlers ──────────────────────────────────────────────────

/** explore_tools: ReAct loop with read-only tools (plan mode). Skipped when execute_tools exists. */
export const exploreToolsHandler: StageHandler = {
  async run(ctx) {
    if (ctx.hasExecute) return; // execute_tools takes precedence
    await runToolLoop(ctx);
  },
};

/** execute_tools: ReAct loop with read/write tools (agent mode). */
export const executeToolsHandler: StageHandler = {
  async run(ctx) {
    await runToolLoop(ctx);
  },
};
