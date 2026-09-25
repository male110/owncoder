/**
 * History management stage handler and related utilities.
 *
 * 方案A：history_compact 节点不再做召回/过滤/注入；执行上下文由任务分解结果提供，
 * 注入统一走 injectHistoryAndUserMessage。本文件保留 computeHistoryLimits /
 * pushHistoryBlockToMessages / pushCurrentUserMessageOnce 等公共工具。
 */

import {
  writeEventLog,
  type ChatAttachment,
  type ChatMessage,
} from "@owncoder/llm";
import type { ChatTurn } from "../types.ts";
import type { StageHandler } from "./types.ts";

// ── Budget safety factor ───────────────────────────────────────────

/**
 * Char/token estimation safety factor. Used for token→char conversions.
 */
const CHAR_TOKEN_SAFETY = 0.75;

// ── Helper Functions ───────────────────────────────────────────────

/**
 * Compute history management limits from context budget.
 * Replaces former hardcoded constants (20K / 9K / 4 turns) so limits
 * scale with contextWindow — a 128K window and a 1M window now get
 * proportionally different summary budgets and recent-turn windows.
 *
 * Now accepts the properly computed `historyBudgetTokens` from
 * `computeContextBudget().segments.history`, which already subtracts all
 * fixed segments (systemPrompt, platformInfo, promptOptimizer, userInput,
 * taskDecomposition, activePlan) from the input budget.
 */
export function computeHistoryLimits(historyBudgetTokens: number): {
  summarySourceMaxChars: number;
  summaryMaxChars: number;
  recentUserTurns: number;
} {
  const safeChars = historyBudgetTokens * 4 * CHAR_TOKEN_SAFETY;
  // Source text for LLM summarization: ~50% of history budget, clamped
  const summarySourceMaxChars = Math.max(10_000, Math.min(60_000, Math.floor(safeChars * 0.50)));
  // Summary output: ~25% of history budget, clamped
  const summaryMaxChars = Math.max(4_000, Math.min(25_000, Math.floor(safeChars * 0.25)));
  // Recent user turns: scales ~1 per 25K chars of budget
  const recentUserTurns = Math.max(2, Math.min(12, Math.floor(safeChars / 25_000)));
  return { summarySourceMaxChars, summaryMaxChars, recentUserTurns };
}

/**
 * 把历史消息压缩为单一 `user` 消息段，用明确的标题 + `[HISTORY]` 前缀
 * 让 LLM 能把它识别为"只读背景"，不会当作新指令。当前任务/当前用户输入
 * 在调用方单独 push 到这段之前，保持"当前优先"的视觉顺序。
 */
export async function pushHistoryBlockToMessages(
  messages: ChatMessage[],
  turns: readonly ChatTurn[],
): Promise<void> {
  if (!turns.length) return;
  const { tagConversationHistory } = await import("../../message-tags.js");
  const lines: string[] = [
    "## CONVERSATION HISTORY (read-only background; never a new request)",
  ];
  // 从新到旧排列：最新历史排在最前面（新→旧）
  for (const turn of [...turns].reverse()) {
    if (turn.role === "tool") {
      const label = turn.toolName ? `Tool result (${turn.toolName})` : "Tool result";
      lines.push(`[HISTORY] tool: ${label}\n${turn.content}`);
    } else {
      lines.push(`[HISTORY] ${turn.role}: ${turn.content}`);
    }
  }
  messages.push({ role: "user", content: tagConversationHistory(lines.join("\n\n")) });
}

/**
 * Append the current user message to `history` exactly once. When the caller
 * (SessionOrchestrator.sendMessage) has already persisted the user message to
 * the session transcript before entering the loop, `history` already ends with
 * it; pushing again would duplicate the message in both the transcript and the
 * LLM context. This guard keeps the injection idempotent.
 */
export function pushCurrentUserMessageOnce(history: ChatTurn[], userMessage: string, attachments: ChatAttachment[] = []): void {
  const last = history[history.length - 1];
  const alreadyAppended =
    !!last && last.role === "user" && last.content === userMessage;
  if (alreadyAppended) {
    if (attachments.length && !last.attachments?.length) last.attachments = attachments;
    return;
  }
  history.push({ role: "user", content: userMessage, attachments: attachments.length ? attachments : undefined });
}

// ── Stage Handler ──────────────────────────────────────────────────

/**
 * history_compact（方案A）：短路。不再召回/过滤/注入历史；
 * 执行上下文由任务分解写入，注入由 injectHistoryAndUserMessage 完成。
 * 会话源历史仍不被本 handler 修改。
 */
export const historyCompactHandler: StageHandler = {
  async run(ctx) {
    // 方案A：始终禁用召回+过滤+注入。执行上下文由任务分解结果提供，
    // 注入统一交给 injectHistoryAndUserMessage（优先使用分解打包的 context）。
    if (ctx.state.userMessageInjected) return;

    writeEventLog({
      category: "other",
      message: "方案A：history_compact 跳过召回/过滤/注入，交由 injectHistoryAndUserMessage",
      details: {
        sessionId: ctx.opts.sessionId,
        hasRelevantHistory: (ctx.state.rawDecompose?.relevantHistory?.trim().length ?? 0) > 0,
        historyTurns: ctx.opts.history.length,
      },
    });
  },
};
