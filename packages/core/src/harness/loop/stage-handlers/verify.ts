/**
 * Verification stage handlers (verify and post_verify).
 *
 * The verify handler marks which node should be used for LLM verification (deferred
 * to loop.ts). The post_verify handler runs execution-grounded verification like
 * syntax checks without LLM involvement.
 */

import { writeEventLog, type ChatMessage } from "@owncoder/llm";
import type { Tracer } from "../../observability.ts";
import type { ToolContext } from "../../execute.ts";
import { VerificationEngine } from "../../verification.ts";
import type { MemoryManager } from "../../memory.ts";
import { emitStage } from "../stages.ts";
import type { AgentLoopOpts } from "../types.ts";
import {
  applyTaskEvent,
  formatVerificationFailureNotice,
  normalizeVerificationResult,
  type TaskRunState,
  type VerificationResult,
} from "../../../task-run.ts";
import type { SchedulerState, StageHandler } from "./types.ts";

type PostVerifySchedulerState = Pick<
  SchedulerState,
  "taskRunState" | "postVerifyFailed" | "successRejected" | "blocked" | "blockedReason" | "lastAssistant"
>;

/** post_verify 硬失败：统一收口为 failed + successRejected/blocked，禁止成功返回。 */
export function sealPostVerifyFailure(
  schedulerState: PostVerifySchedulerState,
  result: VerificationResult,
  reason?: string,
): void {
  const normalized = normalizeVerificationResult(result);
  schedulerState.postVerifyFailed = true;
  schedulerState.successRejected = true;
  schedulerState.blocked = true;
  const terminalReason =
    reason?.trim() ||
    normalized.summary?.trim() ||
    "post_verify 验证未通过";
  schedulerState.blockedReason = terminalReason;

  if (schedulerState.taskRunState) {
    let next: TaskRunState = applyTaskEvent(schedulerState.taskRunState, {
      type: "verification_completed",
      taskId: schedulerState.taskRunState.taskId,
      result: normalized,
    });
    next = applyTaskEvent(next, {
      type: "phase_changed",
      taskId: next.taskId,
      phase: "failed",
      reason: terminalReason,
    });
    schedulerState.taskRunState = next;
    const notice = formatVerificationFailureNotice(next);
    if (notice && schedulerState.lastAssistant !== undefined) {
      const current = schedulerState.lastAssistant?.trim() ?? "";
      schedulerState.lastAssistant = current ? `${current}\n\n${notice}` : notice;
    }
  }
}

// ── Post Verify Implementation ─────────────────────────────────────

export async function runPostVerify(
  opts: AgentLoopOpts,
  toolCtx: ToolContext,
  messages: ChatMessage[],
  memory: MemoryManager,
  tracer: Tracer,
  schedulerState?: PostVerifySchedulerState,
): Promise<void> {
  if (opts.enableVerification === false || opts.mode !== "agent" || !toolCtx.touchedPaths?.length) return;

  const verifSpanId = tracer.startSpan("post_verification", "verification");
  try {
    const verifier = new VerificationEngine(opts.workspaceRoot);
    const verifResult = normalizeVerificationResult(
      await verifier.verify(toolCtx.touchedPaths ?? []),
    );
    if (verifResult.passed) {
      if (schedulerState?.taskRunState) {
        schedulerState.taskRunState = applyTaskEvent(schedulerState.taskRunState, {
          type: "verification_completed",
          taskId: schedulerState.taskRunState.taskId,
          result: verifResult,
        });
      }
      tracer.endSpan(verifSpanId, "ok");
      opts.onEvent?.({
        type: "verification_result",
        passed: true,
        summary: verifResult.summary,
      });
      return;
    }

    if (schedulerState) {
      sealPostVerifyFailure(schedulerState, verifResult);
    }
    tracer.endSpan(verifSpanId, "error");
    opts.onEvent?.({
      type: "verification_result",
      passed: false,
      summary: verifResult.summary,
    });
    const failedChecks = verifResult.checks
      .filter((c) => c.blocking !== false && !c.passed && !c.skipped)
      .map((c) => `- ${c.name} (${c.errors.length} errors)`)
      .join("\n");
    const errorDetail = verifResult.checks
      .filter((c) => c.blocking !== false && !c.passed && !c.skipped)
      .flatMap((c) => c.errors.slice(0, 3))
      .map((e) => `- \`${e.file ?? "?"}:${e.line ?? "?"}\` ${e.message}`)
      .join("\n");
    messages.push({
      role: "system",
      content:
        `## 📋 Final Verification Report\n` +
        `❌ ${verifResult.checks.filter((c) => c.blocking !== false && !c.passed && !c.skipped).length} checks failed\n\n` +
        `### Failed checks\n${failedChecks}\n\n` +
        `### Error details\n${errorDetail}\n\n` +
        `### Suggestions\n${verifResult.suggestions.slice(0, 5).join("\n")}`,
    });
    memory.addError(
      "post_verification_failed",
      verifResult.summary,
      verifResult.suggestions.join("; "),
    );
  } catch (e) {
    tracer.endSpan(verifSpanId, "error");
    const msg = e instanceof Error ? e.message : String(e);
    writeEventLog({
      category: "verify",
      message: `post_verify 验证执行异常: ${msg}`,
      details: {
        sessionId: opts.sessionId,
        error: msg,
        stack: e instanceof Error ? e.stack : undefined,
      },
    });
    const result: VerificationResult = {
      status: "failed",
      passed: false,
      checks: [{
        name: "post_verify",
        type: "execution",
        status: "failed",
        passed: false,
        output: msg,
        duration: 0,
        errors: [{ message: msg, severity: "error" }],
        blocking: true,
        skipped: false,
        source: "post_verify",
      }],
      summary: `post_verify 执行异常: ${msg}`,
      suggestions: [],
    };
    if (schedulerState) {
      sealPostVerifyFailure(schedulerState, result, `post_verify 执行异常: ${msg}`);
    }
    memory.addError("verification_error", msg, "");
  }
}

// ── Stage Handlers ──────────────────────────────────────────────────

/**
 * verify: per-node marker only. The actual LLM verification report is deferred
 * to the single endpoint in `loop.ts` so that one pipeline containing N verify
 * nodes triggers exactly ONE `chatCompletionStream` call. The first enabled
 * verify node is kept so the endpoint can resolve the model + prompt config
 * the same way the previous per-node call would have.
 */
export const verifyHandler: StageHandler = {
  async run(ctx) {
    const { opts, state, node } = ctx;
    emitStage(opts.onEvent, "start", node);
    if (node.enabled !== false && state.verifyNodeForReport === null) {
      state.verifyNodeForReport = node;
    }
    emitStage(opts.onEvent, "done", node);
  },
};

/** post_verify: execution-grounded verification (syntax checks, no LLM). */
export const postVerifyHandler: StageHandler = {
  async run(ctx) {
    const { opts, toolCtx, messages, memory, tracer, node } = ctx;
    emitStage(opts.onEvent, "start", node);
    await runPostVerify(opts, toolCtx, messages, memory, tracer, ctx.state);
    emitStage(opts.onEvent, "done", node);
  },
};
