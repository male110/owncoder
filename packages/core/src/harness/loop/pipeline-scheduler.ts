/**
 * PipelineScheduler (T9) — unified stage dispatch.
 *
 * Walks the pipeline's middle stages in graph order and dispatches each node to
 * its registered StageHandler. Replaces the former loop.ts pattern of hardcoded
 * pre-loop processing (context_gather / task_decompose / history_compact) followed
 * by a midStages switch.
 *
 * Key guarantees:
 * - Execution order is solely determined by pipeline edge order (walkLinearNodes).
 * - context_gather / history_compact / task_decompose are no longer special-cased;
 *   they run at their pipeline position like any other node.
 * - If history_compact does not run before the first model call (disabled or moved),
 *   a fallback injects raw history + user message so the LLM always receives input.
 * - If no explore/execute node exists, a plain LLM completion is inserted before
 *   the first post-model stage (verify / post_verify / present_changes).
 */

import type { PipelineNode } from "@owncoder/settings";
import {
  type SchedulerContext,
  STAGE_HANDLERS,
  isModelCallingStage,
  isPostModelStage,
  injectHistoryAndUserMessage,
  doPlainCompletion,
} from "./stage-handlers.ts";

// Re-export types so consumers only need to import from this module.
export type { SchedulerContext, SchedulerState, StageHandler, StageHandlerContext } from "./stage-handlers.ts";

/**
 * Run all scheduled stages in pipeline order.
 *
 * Mutates `ctx.state` (lastAssistant, correctionCount, aborted, etc.) and
 * `ctx.messages` / `ctx.history` as handlers execute.
 */
export async function runPipelineScheduler(
  stages: ReadonlyArray<PipelineNode>,
  ctx: SchedulerContext,
): Promise<void> {
  let modelCalled = false;
  let plainCompletionDone = false;
  const t0 = performance.now();
  const ts = (label: string) => `[scheduler +${Math.round(performance.now() - t0)}ms] sid=${ctx.opts.sessionId ?? "unknown"} ${label}`;

  for (const node of stages) {
    console.log(ts(`stage start: ${node.type}`));
    const stageT0 = performance.now();
    // Before any model-calling stage, ensure history + user message are in messages.
    if (!ctx.state.userMessageInjected && isModelCallingStage(node)) {
      await injectHistoryAndUserMessage(ctx);
      ctx.state.userMessageInjected = true;
    }

    // No tool stage → insert plain completion before the first post-model stage.
    if (!ctx.hasToolStage && !plainCompletionDone && isPostModelStage(node)) {
      if (!ctx.state.userMessageInjected) {
        await injectHistoryAndUserMessage(ctx);
        ctx.state.userMessageInjected = true;
      }
      ctx.state.lastAssistant = await doPlainCompletion(ctx);
      plainCompletionDone = true;
      modelCalled = true;
    }

    // A handoff (report_blocker) ends the autonomous part of the turn: no
    // self-review, no execution-grounded verification, nothing that would pull
    // the model back into the loop it just exited. present_changes is exempt so
    // the user still sees any diff produced before the handoff.
    if (ctx.state.handoffRequested && node.type !== "present_changes") {
      console.log(ts(`stage skipped: ${node.type} reason=handoff (+${Math.round(performance.now() - stageT0)}ms)`));
      continue;
    }

    const handler = STAGE_HANDLERS.get(node.type);
    if (handler) {
      try {
        await handler.run({ ...ctx, node });
      } catch (error) {
        console.log(ts(`stage error: ${node.type} (+${Math.round(performance.now() - stageT0)}ms)`));
        throw error;
      }
      if (isModelCallingStage(node)) {
        modelCalled = true;
      }
    }

    console.log(ts(`stage ${handler ? "done" : "skipped"}: ${node.type} (+${Math.round(performance.now() - stageT0)}ms)`));

    if (ctx.state.aborted || ctx.state.blocked || ctx.state.awaitingUserConfirmation || ctx.state.shortCircuited) break;
  }

  // No tool stage and no post-model stages → plain completion at the end.
  if (!ctx.hasToolStage && !plainCompletionDone && !modelCalled) {
    if (!ctx.state.userMessageInjected) {
      await injectHistoryAndUserMessage(ctx);
      ctx.state.userMessageInjected = true;
    }
    ctx.state.lastAssistant = await doPlainCompletion(ctx);
  }
}