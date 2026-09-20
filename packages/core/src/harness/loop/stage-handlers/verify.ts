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
import type { StageHandler } from "./types.ts";

// ── Post Verify Implementation ─────────────────────────────────────

export async function runPostVerify(
  opts: AgentLoopOpts,
  toolCtx: ToolContext,
  messages: ChatMessage[],
  memory: MemoryManager,
  tracer: Tracer,
): Promise<void> {
  if (opts.enableVerification === false || opts.mode !== "agent" || !toolCtx.touchedPaths?.length) return;

  const verifSpanId = tracer.startSpan("post_verification", "verification");
  try {
    const verifier = new VerificationEngine(opts.workspaceRoot);
    const verifResult = await verifier.verify(toolCtx.touchedPaths ?? []);
    tracer.endSpan(verifSpanId, verifResult.passed ? "ok" : "error");
    opts.onEvent?.({
      type: "verification_result",
      passed: verifResult.passed,
      summary: verifResult.summary,
    });
    if (!verifResult.passed) {
      const failedChecks = verifResult.checks
        .filter((c) => !c.passed)
        .map((c) => `- ${c.name} (${c.errors.length} errors)`)
        .join("\n");
      const errorDetail = verifResult.checks
        .filter((c) => !c.passed)
        .flatMap((c) => c.errors.slice(0, 3))
        .map((e) => `- \`${e.file}:${e.line ?? "?"}\` ${e.message}`)
        .join("\n");
      messages.push({
        role: "system",
        content:
          `## 📋 Final Verification Report\n` +
          `${
            verifResult.passed
              ? "✅ All checks passed"
              : `❌ ${verifResult.checks.filter((c) => !c.passed).length} checks failed\n\n` +
                `### Failed checks\n${failedChecks}\n\n` +
                `### Error details\n${errorDetail}\n\n` +
                `### Suggestions\n${verifResult.suggestions.slice(0, 5).join("\n")}`
          }`,
      });
      if (!verifResult.passed) {
        memory.addError(
          "post_verification_failed",
          verifResult.summary,
          verifResult.suggestions.join("; "),
        );
      }
    }
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
    await runPostVerify(opts, toolCtx, messages, memory, tracer);
    emitStage(opts.onEvent, "done", node);
  },
};
